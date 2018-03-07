/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

const async = require('async');
const _ = require('lodash');

const request = require('request');
const io = require('socket.io-client');
const wildcardPatch = require('socketio-wildcard')(io.Manager);

const deepEqual = require('deep-equal');
const debug = require('debug')('socketio');
const engineUtil = require('./engine_util');
const EngineHttp = require('./engine_http');
const template = engineUtil.template;
module.exports = SocketIoEngine;

function SocketIoEngine(script) {
  this.config = script.config;

  this.socketioOpts = this.config.socketio || {};
  this.httpDelegate = new EngineHttp(script);
}

SocketIoEngine.prototype.createScenario = function(scenarioSpec, ee) {
  var self = this;

  engineUtil.ensurePropertyIsAList(scenarioSpec, 'beforeRequest');
  engineUtil.ensurePropertyIsAList(scenarioSpec, 'afterResponse');

  let tasks = _.map(scenarioSpec.flow, function(rs) {
    if (rs.think) {
      return engineUtil.createThink(rs, _.get(self.config, 'defaults.think', {}));
    }
    return self.step(rs, ee, {
        beforeRequest: scenarioSpec.beforeRequest,
        afterResponse: scenarioSpec.afterResponse,
    });
  });

  return self.compile(tasks, scenarioSpec.flow, ee);
};

function markEndTime(ee, context, startedAt) {
  let endedAt = process.hrtime(startedAt);
  let delta = (endedAt[0] * 1e9) + endedAt[1];
  ee.emit('response', delta, 0, context._uid);
}

function runAfterResponseHandlers(afterResponseFunctions, config, data, context, ee, callback) {
  // Now run afterResponse processors
  async.eachSeries(
    afterResponseFunctions,
    function iteratee(functionName, next) {
      let processFunc = config.processor[functionName];
      processFunc(data, context, ee, function(err) {
        if (err) {
          return next(err);
        }
        return next(null);
      });
    }, function done(err) {
      if (err) {
        debug(err);
        ee.emit('error', err.code || err.message);
        return callback(err, context);
      }
      return callback(null, context);
    });
}

function processResponse(ee, afterResponseFunctions, opts, config, expectedData, response, context, callback) {
  // Do we have supplied data to validate?
  if (response.data && !deepEqual(expectedData, response.data)) {
    debug(expectedData);
    let err = 'data is not valid';
    ee.emit('error', err);
    return callback(err, context);
  }

  // If no capture or match specified, then we consider it a success at this point...
  if (!response.capture && !response.match) {
    return runAfterResponseHandlers(afterResponseFunctions, config, expectedData, context, ee, callback);
  }

  // Construct the (HTTP) response...
  let fauxResponse = {body: JSON.stringify(expectedData)};

  // Handle the capture or match clauses...
  engineUtil.captureOrMatch(response, fauxResponse, context, function(err, result) {
    // Were we unable to invoke captureOrMatch?
    if (err) {
      debug(expectedData);
      ee.emit('error', err);
      return callback(err, context);
    }

    // Do we have any failed matches?
    let haveFailedMatches = _.some(result.matches, function(v, k) {
      return !v.success;
    });

    // How to handle failed matches?
    if (haveFailedMatches) {
      // TODO: Should log the details of the match somewhere
      ee.emit('error', 'Failed match');
      return callback(new Error('Failed match'), context);
    } else {
      // Emit match events...
      _.each(result.matches, function(v, k) {
        ee.emit('match', v.success, {
          expected: v.expected,
          got: v.got,
          expression: v.expression
        });
      });

      // Populate the context with captured values
      _.each(result.captures, function(v, k) {
        context.vars[k] = v;
      });

      runAfterResponseHandlers(afterResponseFunctions, config, expectedData, context, ee, (err) => {
        if (err) return callback(err, context);
        // Replace the base object context
        // Question: Should this be JSON object or String?
        context.vars.$ = fauxResponse.body;

        // Increment the success count...
        context._successCount++;

        return callback(null, context);
      })
    }
  });
}

function allResponsesCompleted(o) {
  return incompleteResponseCount(o) === 0;
}

function incompleteResponseCount(o) {
  return Object.keys(o).reduce((m, k) => m + (o[k] || 0), 0);
}

SocketIoEngine.prototype.step = function (requestSpec, ee, opts) {
  opts = opts || {};
  let self = this;
  let config = this.config;
  let responseTimeout;

  if (requestSpec.loop) {
    let steps = _.map(requestSpec.loop, function(rs) {
      if (!rs.emit) {
        return self.httpDelegate.step(rs, ee);
      }
      return self.step(rs, ee, opts);
    });

    return engineUtil.createLoopWithCount(
      requestSpec.count || -1,
      steps,
      {
        loopValue: requestSpec.loopValue,
        overValues: requestSpec.over
      }
    );
  }

  const configureOutgoingData = function (emit, context, callback) {
    const initialOutgoing = _.cloneDeep({
      channel: template(emit.channel, context),
      data: template(emit.data, context)
    });
    const beforeRequestFunctions = _.concat(opts.beforeRequest || [], emit.beforeRequest || []);

    async.eachSeries(
      beforeRequestFunctions,
      function iteratee(functionName, next) {
        let processFunc = config.processor[functionName];
        processFunc(initialOutgoing, context, ee, function(err) {
          if (err) {
            return next(err);
          }
          return next(null);
        });
      },
      function done(err) {
        if (err) {
          debug(err);
          let errCode = err.code || err.message;
          // FIXME: Should not need to have to emit manually here
          ee.emit('error', errCode);
          return callback(err, context);
        }

        let outgoing = {
          channel: template(initialOutgoing.channel, context),
          data: template(initialOutgoing.data, context)
        };

        callback(null, outgoing);
      });
  };

  function configureResponseListeners(rootEmit, context, callback) {
    const socketio = context.sockets[rootEmit.namespace] || null;
    const expectedResponseCounts = context.vars._expectedResponseCounts;

    function walk(emit, parentTimes = 1) {
      const responsesArr = (Array.isArray(emit.response) ? emit.response : [emit.response]);
      responsesArr
        .map(r => ({
          channel: template(r.channel, context),
          data: template(r.data, context),
          capture: template(r.capture, context),
          match: template(r.match, context),
          emit: r.emit ? Object.assign({namespace: rootEmit.namespace}, r.emit) : null,
          times: r.times || 1,
        }))
        .forEach(r => {
          if (typeof expectedResponseCounts[r.channel] === 'undefined') {
            expectedResponseCounts[r.channel] = (parentTimes * r.times);
            socketio.on(r.channel, function receive(data) {
              expectedResponseCounts[r.channel] -= 1;
              if (expectedResponseCounts[r.channel] <= 0) {
                socketio.off(r.channel);
              }
              return callback(null, { request: r, data });
            });
          } else {
            expectedResponseCounts[r.channel] += (parentTimes * r.times);
          }
          if (r.emit) walk(r.emit, (parentTimes * r.times));
        });
    }

    walk(rootEmit);

    // If we don't get a response within the timeout, fire an error
    let waitTime = self.config.timeout || 10;
    waitTime *= 1000;
    responseTimeout = setTimeout(function responseTimeout() {
      if (!allResponsesCompleted(expectedResponseCounts)) {
        ee.emit('error', 'ResponseTimeout');
        return callback({
          msg: 'Responses did not complete within timeout',
          expectedResponseCounts,
        }, context);
      }
    }, waitTime);
  }

  const handleEmit = function (emit, context, callback) {
    const socketio = context.sockets[emit.namespace] || null;

    ee.emit('request');

    if (!(emit && emit.channel && socketio)) {
      return ee.emit('error', 'invalid arguments');
    }

    configureOutgoingData(emit, context, (err, outgoing) => {
      if (err) return callback(err);

      const outgoingData = typeof outgoing.data === 'string' ? JSON.parse(outgoing.data) : outgoing.data;

      socketio.emit(outgoing.channel, outgoingData);
      return callback(null, context);
    });
  };

  const f = function(context, callback) {
    context.vars._expectedResponseCounts = {};
    // Only process emit requests; delegate the rest to the HTTP engine (or think utility)
    if (requestSpec.think) {
      return engineUtil.createThink(requestSpec, _.get(self.config, 'defaults.think', {}));
    }
    if (!requestSpec.emit) {
      let delegateFunc = self.httpDelegate.step(requestSpec, ee);
      return delegateFunc(context, callback);
    }

    let startedAt = process.hrtime();

    const maybeComplete = (err, context) => {
      const expectedResponseCounts = context.vars._expectedResponseCounts;
      if (err || allResponsesCompleted(expectedResponseCounts)) {
        markEndTime(ee, context, startedAt);
        clearTimeout(responseTimeout);
        callback(err, context);
      }
    };

    const afterResponseFunctions = _.concat(opts.afterResponse || [], requestSpec.emit.afterResponse || []);
    configureResponseListeners(requestSpec.emit, context, (err, response) => {
      if (err) return maybeComplete(err, context);
      processResponse(ee, afterResponseFunctions, opts, config, response.data, response.request, context, (err, ctx) => {
        if (err) return maybeComplete(err, ctx);
        if (response.request.emit) handleEmit(response.request.emit, ctx, maybeComplete);
        else maybeComplete(err, ctx);
      });
    });

    handleEmit(requestSpec.emit, context, maybeComplete);
  };

  function preStep(context, callback){
    // Set default namespace in emit action
    requestSpec.emit.namespace = template(requestSpec.emit.namespace, context) || "/";

    self.loadContextSocket(requestSpec.emit.namespace, context, function(err){
      if(err) {
        debug(err);
        ee.emit('error', err.message);
        return callback(err, context);
      }

      return f(context, callback);
    });
  }

  if(requestSpec.emit) {
    return preStep;
  } else {
    return f;
  }
};

SocketIoEngine.prototype.loadContextSocket = function(namespace, context, cb) {
  context.sockets = context.sockets || {};

  if(!context.sockets[namespace]) {
    let target = this.config.target + namespace;
    let tls = this.config.tls || {};

    const socketioOpts = template(this.socketioOpts, context);
    let options = _.extend(
      {},
      socketioOpts, // templated
      tls
    );

    let socket = io(target, options);
    context.sockets[namespace] = socket;
    wildcardPatch(socket);

    socket.on('*', function () {
      context.__receivedMessageCount++;
    });

    socket.once('connect', function() {
      cb(null, socket);
    });
    socket.once('connect_error', function(err) {
      cb(err, null);
    });
  } else {
    return cb(null, context.sockets[namespace]);
  }
};

SocketIoEngine.prototype.closeContextSockets = function (context) {
  if(context.sockets && Object.keys(context.sockets).length > 0) {
    var namespaces = Object.keys(context.sockets);
    namespaces.forEach(function(namespace){
      context.sockets[namespace].disconnect();
    });
  }
};


SocketIoEngine.prototype.compile = function (tasks, scenarioSpec, ee) {
  let self = this;

  function zero(callback, context) {
    context.__receivedMessageCount = 0;
    ee.emit('started');
    self.loadContextSocket('/', context, function done(err) {
      if (err) {
        ee.emit('error', err);
        return callback(err, context);
      }

      return callback(null, context);
    });
  }

  return function scenario(initialContext, callback) {
    initialContext._successCount = 0;
    initialContext._jar = request.jar();
    initialContext._pendingRequests = _.size(
        _.reject(scenarioSpec, function(rs) {
          return (typeof rs.think === 'number');
        }));

    let steps = _.flatten([
      function z(cb) {
        return zero(cb, initialContext);
      },
      tasks
    ]);

    async.waterfall(
        steps,
        function scenarioWaterfallCb(err, context) {
          if (err) {
            debug(err);
          }
          if (context) {
            self.closeContextSockets(context);
          }
          return callback(err, context);
        });
  };
};
