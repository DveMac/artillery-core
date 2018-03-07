/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

const sinon = require('sinon');
const EventEmitter = require('events');
const test = require('tape');
const SocketIoEngine = require('../../lib/engine_socketio');
const processor = require('./engine_socketio.test.processor.js');

const createServer = require('../targets/simple_socketio');

const script = {
  config: {
    target: 'http://localhost:10333'
  },
  scenarios: [
    {
      name: 'Whatever',
      flow: [
        {
          emit: {
            channel: 'echo',
            data: 'hello Socket.io'
          }
        }
      ]
    }
  ]
};

const scriptWithoutEmits = {
  config: {
    target: 'http://localhost:10334'
  },
  scenarios: [{
    flow: [
      { think: 1 }
    ]
  }]
};

const scriptWithHooks = {
  config: {
    target: 'http://localhost:10335',
    processor: './engine_socketio.test.processor.js'
  },
  scenarios: [
    {
      name: 'WithHooks',
      flow: [
        {
          beforeRequest: 'flowBeforeRequest',
          afterResponse: 'flowAfterResponse',
          emit: {
            beforeRequest: 'emitBeforeRequest',
            afterResponse: 'emitAfterResponse',
            channel: 'echo',
            data: 'hello Socket.io'
          }
        }
      ]
    }
  ]
};

test('SocketIo engine interface', function(t) {
  const target = createServer();

  target.listen(10333, function() {
    const engine = new SocketIoEngine(script);
    const ee = new EventEmitter();

    const runScenario = engine.createScenario(script.scenarios[0], ee);

    t.assert(engine, 'Can init the engine');
    t.assert(typeof runScenario === 'function', 'Can create a virtual user function');

    target.close();
    t.end();
  });
});

test('Processor hooks', function(t) {
  const target = createServer();
  const hookSpy = sinon.spy((outgoingOrResponse, context, ee, next) => {
    outgoingOrResponse.counter += 1;
    next();
  });
  sinon.stub(processor, 'flowBeforeRequest', hookSpy);
  sinon.stub(processor, 'emitBeforeRequest', hookSpy);
  sinon.stub(processor, 'flowAfterResponse', hookSpy);
  sinon.stub(processor, 'emitAfterResponse', hookSpy);

  target.listen(10335, function() {
    const engine = new SocketIoEngine(scriptWithHooks);
    const ee = new EventEmitter();

    const runScenario = engine.createScenario(script.scenarios[0], ee);

    t.assert(engine, 'Can init the engine');
    t.assert(typeof runScenario === 'function', 'Can create a virtual user function');

    runScenario({ vars: {} }, (err, outgoingOrResponse) => {
      t.assert(!err, 'Scenario completed with no errors');
      t.equal(hookSpy.callCount, 4);
      t.deepEqual(hookSpy.firstCall, []);
      t.deepEqual(hookSpy.secondCall, []);
      t.deepEqual(outgoingOrResponse, {});

      t.end();
      target.close();
    });
  });
});

test('Passive listening', function(t) {
  const target = createServer();
  target.listen(10334, function() {
    const engine = new SocketIoEngine(scriptWithoutEmits);
    const ee = new EventEmitter();

    const runScenario = engine.createScenario(scriptWithoutEmits.scenarios[0], ee);
    const initialContext = {
      vars: {}
    };

    runScenario(initialContext, function userDone(err, finalContext) {
      t.assert(!err, 'Scenario completed with no errors');
      t.assert(finalContext.__receivedMessageCount === 1, 'Received one message upon connecting');

      t.end();
      target.close();
    });
  });
});

