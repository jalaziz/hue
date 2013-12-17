// Licensed to Cloudera, Inc. under one
// or more contributor license agreements.  See the NOTICE file
// distributed with this work for additional information
// regarding copyright ownership.  Cloudera, Inc. licenses this file
// to you under the Apache License, Version 2.0 (the
// "License"); you may not use this file except in compliance
// with the License.  You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.


function BeeswaxViewModel(server) {
  var self = this;

  self.server = ko.observable(server);
  self.databases = ko.observableArray();
  self.selectedDatabase = ko.observable(0);
  self.query = ko.mapping.fromJS({
    'id': -1,
    'query': '',
    'name': null,
    'description': null,
    'errors': []
  });
  self.settings = ko.observableArray();
  self.fileResources = ko.observableArray();
  self.functions = ko.observableArray();
  self.logs = ko.observableArray();
  self.explanation = ko.observable();
  self.watchURL = ko.observable();
  self.resultsURL = ko.observable(null);
  self.columns = ko.observableArray();
  self.rows = ko.observableArray();
  self.resultsEmpty = ko.observable(false);
  self.state = ko.observable('full');

  self.hasMoreResults = ko.computed(function() {
    return self.resultsURL() != null;
  });

  self.database = ko.computed({
    'read': function() {
      if (self.databases()) {
        return self.databases()[self.selectedDatabase()];
      } else{
        return "";
      }
    },
    'write': function(value) {
      self.selectedDatabase(self.databases.indexOf(value));
    }
  });

  self.getFirstDatabase = function() {
    if (self.databases()) {
      return self.databases()[0];
    } else {
      return null;
    }
  };

  self.updateDatabases = function(databases) {
    self.databases(databases);

    var key = 'hueBeeswaxLastDatabase-' + self.server();
    var last = $.totalStorage(key) || ((databases.length > 0) ? databases[0] : null);
    if (last) {
      self.database(last);
    }
  };

  self.updateSettings = function(settings) {
    self.settings(settings);
  };

  self.updateFileResources = function(file_resources) {
    self.fileResources(file_resources);
  };

  self.updateFunctions = function(functions) {
    self.functions(functions);
  };

  self.updateQuery = function(design) {
    self.query.query(design.query);
    self.query.id(design.id);
    self.query.name(design.name);
    self.query.description(design.desc);
    self.database(design.database);
  };

  self.chooseDatabase = function(value, e) {
    var key = 'hueBeeswaxLastDatabase-' + self.server().name();
    self.selectedDatabase(self.databases.indexOf(value));
    $.totalStorage(key, value);
  };

  self.addSetting = function() {
    var obj = {
      'key': ko.observable(),
      'value': ko.observable()
    };
    obj.key.subscribe(function() {
      self.settings.valueHasMutated();
    });
    obj.value.subscribe(function() {
      self.settings.valueHasMutated();
    });
    self.settings.push(obj);
  };

  self.removeSetting = function(index) {
    self.settings.splice(index, 1);
  };

  self.addFileResources = function() {
    var obj = {
      'type': ko.observable(),
      'path': ko.observable()
    };
    obj.type.subscribe(function() {
      self.fileResources.valueHasMutated();
    });
    obj.path.subscribe(function() {
      self.fileResources.valueHasMutated();
    });
    self.fileResources.push(obj);
  };

  self.removeFileResources = function(index) {
    self.fileResources.splice(index, 1);
  };

  self.addFunction = function() {
    var obj = {
      'name': ko.observable(),
      'class_name': ko.observable()
    };
    obj.name.subscribe(function() {
      self.functions.valueHasMutated();
    });
    obj.class_name.subscribe(function() {
      self.functions.valueHasMutated();
    });
    self.functions.push(obj);
  };

  self.removeFunction = function(index) {
    self.functions.splice(index, 1);
  };

  self.getSettingsFormData = function() {
    var data = {
      'settings-next_form_id': self.settings().length
    };
    var index = 0;
    ko.utils.arrayForEach(self.fileResources, function(setting) {
      data['settings-' + index + '-key'] = setting.key();
      data['settings-' + index + '-value'] = setting.value();
    });
    return data;
  };

  self.getFileResourcesFormData = function() {
    var data = {
      'file_resources-next_form_id': self.fileResources().length
    };
    var index = 0;
    ko.utils.arrayForEach(self.fileResources, function(file_resource) {
      data['file_resources-' + index + '-type'] = file_resource.type();
      data['file_resources-' + index + '-path'] = file_resource.path();
    });
    return data;
  };

  self.getFunctionsFormData = function() {
    var data = {
      'functions-next_form_id': self.functions().length
    };
    var index = 0;
    ko.utils.arrayForEach(self.functions, function(_function) {
      data['functions-' + index + '-name'] = _function.name();
      data['functions-' + index + '-class_name'] = _function.class_name();
    });
    return data;
  };

  var error_fn = function(jqXHR, status, errorThrown) {
    try {
      $(document).trigger('server.error', $.parseJSON(jqXHR.responseText));
    } catch(e) {
      $(document).trigger('server.unmanageable_error', jqXHR.responseText);
    }
  };

  self.fetchDatabases = function() {
    var request = {
      url: '/' + self.server() + '/api/databases',
      dataType: 'json',
      type: 'GET',
      success: function(data) {
        self.updateDatabases(data.databases);
      },
      error: error_fn
    };
    $.ajax(request);
  };

  self.explainQuery = function() {
    $(document).trigger('execute.query', data);

    var data = {
      'query-query': self.query.query(),
      'query-database': self.database()
    };
    $.extend(data, self.getSettingsFormData());
    $.extend(data, self.getFileResourcesFormData());
    $.extend(data, self.getFunctionsFormData());
    var request = {
      url: '/' + self.server() + '/api/execute/?explain=true',
      dataType: 'json',
      type: 'POST',
      success: function(data) {
        self.query.errors.removeAll();
        if (data.status == 0) {
          self.logs.removeAll();
          self.rows.removeAll();
          self.columns.removeAll();
          self.explanation(data.explanation);
          self.state('explanation');
        } else {
          self.query.errors.push(data.message);
        }
        $(document).trigger('executed.query', data);
      },
      error: error_fn,
      data: data
    };
    $.ajax(request);
  };

  self.fetchQuery = function(id) {
    var _id = id || self.query.id();
    if (_id && _id != -1) {
      var request = {
        url: '/beeswax/api/query/' + _id + '/get',
        dataType: 'json',
        type: 'GET',
        success: function(data) {
          self.updateQuery(data.design);
        },
        error: error_fn
      };
      $.ajax(request);
    }
  };

  self.saveQuery = function() {
    var self = this;
    if (self.query.query() && self.query.name()) {
      var data = ko.mapping.toJS(self.query);
      data['desc'] = data['description'];
      data['database'] = self.database();
      var url = '/' + self.server() + '/api/query/';
      if (self.query.id() && self.query.id() != -1) {
        url += self.query.id() + '/';
      }
      var request = {
        url: url,
        dataType: 'json',
        type: 'POST',
        success: function(data) {
          $(document).trigger('saved.query', data);
        },
        error: function() {
          $(document).trigger('error.query');
        },
        data: data
      };
      $.ajax(request);
    }
  };

  self.executeQuery = function() {
    $(document).trigger('execute.query', data);

    var data = {
      'query-query': self.query.query(),
      'query-database': self.database()
    };
    $.extend(data, self.getSettingsFormData());
    $.extend(data, self.getFileResourcesFormData());
    $.extend(data, self.getFunctionsFormData());
    var request = {
      url: '/' + self.server() + '/api/execute/',
      dataType: 'json',
      type: 'POST',
      success: function(data) {
        self.query.errors.removeAll();
        if (data.status == 0) {
          self.query.id(data.id);
          self.logs.removeAll();
          self.rows.removeAll();
          self.columns.removeAll();
          self.resultsURL('/' + self.server() + '/results/' + self.query.id() + '/0?format=json');
          self.watchURL(data.watch_url);
          self.watchQueryLoop();
        } else {
          self.query.errors.push(data.message);
        }
        $(document).trigger('executed.query', data);
      },
      error: error_fn,
      data: data
    };
    $.ajax(request);
  };

  self.watchQuery = function() {
    $(document).trigger('watch.query');

    var data = {
      'query-query': self.query.query(),
      'query-database': self.database()
    };
    $.extend(data, self.getSettingsFormData());
    $.extend(data, self.getFileResourcesFormData());
    $.extend(data, self.getFunctionsFormData());
    var request = {
      url: self.watchURL(),
      dataType: 'json',
      type: 'POST',
      success: function(data) {
        $(document).trigger('watched.query', data);
      },
      error: error_fn,
      data: data
    };
    $.ajax(request);
  };

  self.watchQueryLoop = function() {
    var TIMEOUT = 1000;
    var timer = null;
    var executed_once = false;
    var fn = function() {
      $(document).one('watched.query', function(e, data) {
        if (executed_once && (data.isSuccess || data.isFailure)) {
          clearTimeout(timer);
          self.fetchResults();
        } else {
          executed_once = true;
          if (data.log) {
            self.logs.push(data.log);
          }
          timer = setTimeout(fn, TIMEOUT);
        }
      });
      self.watchQuery();
    };
    self.state('watching');
    timer = setTimeout(fn, TIMEOUT);
  };

  self.fetchResults = function() {
    $(document).trigger('fetch.results');
    var request = {
      url: self.resultsURL(),
      dataType: 'json',
      type: 'GET',
      success: function(data) {
        self.state('results');
        self.columns(data.columns);
        self.rows.push.apply(self.rows, data.results);
        self.resultsEmpty(self.rows().length == 0);
        if (data.has_more) {
          self.resultsURL(data.next_json_set);
        } else {
          self.resultsURL(null);
        }
        $(document).trigger('fetched.results', data);
      },
      error: error_fn
    };
    $.ajax(request);
  };

  // Events
  // Remove watched query event that watchQueryLoop may be bound to.
  $(document).on('server.unmanageable_error', function() {
    $(document).off('watched.query');
  });
}
