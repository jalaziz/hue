#!/usr/bin/env python
# Licensed to Cloudera, Inc. under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  Cloudera, Inc. licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

import json
import logging

from django.core.urlresolvers import reverse
from django.http import HttpResponse, Http404
from django.utils.translation import ugettext as _

from desktop.context_processors import get_app_name
from desktop.lib.exceptions_renderable import PopupException

from jobsub.parameterization import substitute_variables

import beeswax.design
import beeswax.forms
import beeswax.models
import beeswax.management.commands.beeswax_install_examples

from beeswax.forms import QueryForm
from beeswax.design import HQLdesign
from beeswax.server import dbms
from beeswax.server.dbms import expand_exception, get_query_server_config
from beeswax.views import authorized_get_design, make_parameterization_form,\
                          safe_get_design, save_design


LOG = logging.getLogger(__name__)


def error_handler(view_fn):
  def decorator(*args, **kwargs):
    try:
      return view_fn(*args, **kwargs)
    except Http404, e:
      raise e
    except Exception, e:
      response = {
        'error': str(e)
      }
      return HttpResponse(json.dumps(response), mimetype="application/json", status=500)
  return decorator


@error_handler
def databases(request):
  app_name = get_app_name(request)
  query_server = dbms.get_query_server_config(app_name)

  if not query_server:
    raise Http404

  db = dbms.get(request.user, query_server)

  response = {
    'status': 0,
    'databases': db.get_databases()
  }

  return HttpResponse(json.dumps(response), mimetype="application/json")


@error_handler
def parameters(request, design_id=None):
  response = {'status': -1, 'message': ''}

  # Use POST request to not confine query length.
  if request.method != 'POST':
    response['message'] = _('A POST request is required.')

  parameterization_form_cls = make_parameterization_form(request.POST.get('query', ''))
  parameterization_form = parameterization_form_cls(prefix="parameterization")

  response['parameters'] = [field.html_name for field in parameterization_form]
  response['status']= 0

  return HttpResponse(json.dumps(response), mimetype="application/json")


def execute_directly(request, query, design, query_server, tablename=None, **kwargs):
  if design is not None:
    design = authorized_get_design(request, design.id)

  db = dbms.get(request.user, query_server)
  database = query.query.get('database', 'default')
  db.use(database)

  history_obj = db.execute_query(query, design)
  watch_url = reverse(get_app_name(request) + ':watch_query_refresh_json', kwargs={'id': history_obj.id})

  response = {
    'status': 0,
    'id': history_obj.id,
    'watch_url': watch_url
  }

  return HttpResponse(json.dumps(response), mimetype="application/json")


def explain_directly(request, query, design, query_server):
  explanation = dbms.get(request.user, query_server).explain(query)
  
  response = {
    'status': 0,
    'explanation': explanation.textual
  }

  return HttpResponse(json.dumps(response), mimetype="application/json")


@error_handler
def execute(request, design_id=None):
  response = {'status': -1, 'message': ''}

  if request.method != 'POST':
    response['message'] = _('A POST request is required.')
  
  app_name = get_app_name(request)
  query_server = get_query_server_config(app_name)
  query_type = beeswax.models.SavedQuery.TYPES_MAPPING[app_name]
  design = safe_get_design(request, query_type, design_id)

  try:
    query_form = get_query_form(request)

    if query_form.is_valid():
      query_str = query_form.query.cleaned_data["query"]
      explain = request.GET.get('explain', 'false').lower() == 'true'
      design = save_design(request, query_form, query_type, design, False)

      if query_form.query.cleaned_data['is_parameterized']:
        # Parameterized query
        parameterization_form_cls = make_parameterization_form(query_str)
        if not parameterization_form_cls:
          raise PopupException(_("Query is not parameterizable."))

        parameterization_form = parameterization_form_cls(request.REQUEST, prefix="parameterization")

        if parameterization_form.is_valid():
          real_query = substitute_variables(query_str, parameterization_form.cleaned_data)
          query = HQLdesign(query_form, query_type=query_type)
          query._data_dict['query']['query'] = real_query

          try:
            if explain:
              return explain_directly(request, query, design, query_server)
            else:
              return execute_directly(request, query, design, query_server)

          except Exception, ex:
            db = dbms.get(request.user, query_server)
            error_message, log = expand_exception(ex, db)
            response['message'] = error_message
            return HttpResponse(json.dumps(response), mimetype="application/json")

      else:
        # non-parameterized query
        query = HQLdesign(query_form, query_type=query_type)
        if request.GET.get('explain', 'false').lower() == 'true':
          return explain_directly(request, query, design, query_server)
        else:
          return execute_directly(request, query, design, query_server)
    else:
      response['message'] = _('There was an error with your query.')
      response['errors'] = query_form.query.errors
  except RuntimeError, e:
    response['message']= str(e)

  return HttpResponse(json.dumps(response), mimetype="application/json")


def save(request, id):
  """
  Save the results of a query to an HDFS directory or Hive table.
  """
  query_history = authorized_get_history(request, id, must_exist=True)

  app_name = get_app_name(request)
  server_id, state = _get_query_handle_and_state(query_history)
  query_history.save_state(state)
  error_msg, log = None, None

  if request.method == 'POST':
    if not query_history.is_success():
      msg = _('This query is %(state)s. Results unavailable.') % {'state': state}
      raise PopupException(msg)

    db = dbms.get(request.user, query_history.get_query_server_config())
    form = beeswax.forms.SaveResultsForm(request.POST, db=db, fs=request.fs)

    if request.POST.get('cancel'):
      return format_preserving_redirect(request, '/%s/watch/%s' % (app_name, id))

    if form.is_valid():
      try:
        handle, state = _get_query_handle_and_state(query_history)
        result_meta = db.get_results_metadata(handle)
      except Exception, ex:
        raise PopupException(_('Cannot find query: %s') % ex)

      try:
        if form.cleaned_data['save_target'] == form.SAVE_TYPE_DIR:
          target_dir = form.cleaned_data['target_dir']
          query_history = db.insert_query_into_directory(query_history, target_dir)
          redirected = redirect(reverse('beeswax:watch_query', args=[query_history.id]) \
                                + '?on_success_url=' + reverse('filebrowser.views.view', kwargs={'path': target_dir}))
        elif form.cleaned_data['save_target'] == form.SAVE_TYPE_TBL:
          redirected = db.create_table_as_a_select(request, query_history, form.cleaned_data['target_table'], result_meta)
      except Exception, ex:
        error_msg, log = expand_exception(ex, db)
        raise PopupException(_('The result could not be saved: %s.') % log, detail=ex)

      return redirected
  else:
    form = beeswax.forms.SaveResultsForm()

  if error_msg:
    error_msg = _('Failed to save results from query: %(error)s.') % {'error': error_msg}

  return render('save_results.mako', request, {
    'action': reverse(get_app_name(request) + ':save_results', kwargs={'id': str(id)}),
    'form': form,
    'error_msg': error_msg,
    'log': log,
  })


def get_query_form(request):
  # Get database choices
  query_server = dbms.get_query_server_config(get_app_name(request))
  db = dbms.get(request.user, query_server)
  databases = [(database, database) for database in db.get_databases()]

  if not databases:
    raise RuntimeError(_("No databases are available. Permissions could be missing."))

  query_form = QueryForm()
  query_form.bind(request.POST)
  query_form.query.fields['database'].choices = databases # Could not do it in the form

  return query_form
