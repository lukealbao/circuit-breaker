'use strict';

var path = require('path');
var expect = require('chai').expect;
var sinon = require('sinon');
var Promise = require('bluebird');
var CircuitBreaker = require(path.resolve(__dirname, '..', 'index'));

describe('CircuitBreaker.execute(Promise) -> Promise', function () {
  var circuit;
  var sandbox;
  var clock;
  function pass () { return Promise.resolve('ok'); }
  function fail () { return Promise.reject(new Error('notOk')); }
  beforeEach(function () {
    sandbox = sinon.sandbox.create();
    clock = sandbox.useFakeTimers();
    circuit = new CircuitBreaker();
  });
  afterEach(function () {
    sandbox.restore();
  });

  describe('Input', function () {
    it('Accepts a function with no arguments', () => {
      var spy = sandbox.spy(pass);
      return circuit.execute(spy)
        .then(function (val) {
          expect(val).to.equal('ok');
          sinon.assert.called(spy);
        });
    });

    it('Applies a function with any additional arguments', () => {
      var spy = sandbox.spy(pass);
      return circuit.execute(spy, 'ok')
        .then(function () {
          sinon.assert.called(spy.withArgs('ok'));
        });
    });
  });

  describe('Success', function () {
    it('Resolves the underlying promise value', function () {
      var circuit = new CircuitBreaker();
      return circuit.execute(() => Promise.resolve('Ok'))
             .then(function (value) {
               expect(value).to.equal('Ok');
             });
    });
  });

  describe('Failures', function () {
    it('Underlying Promise rejection increments error count', function () {
      return circuit.execute(() => Promise.reject(new Error(1)))
             .catch(function (error) {
               return circuit.execute(() => Promise.reject(new Error(2)));
             }).catch(function (error) {
               expect(circuit.errorCount).to.equal(2);
             });
    });

    it('Rejects[bluebird.TimeoutError] when underlying promise goes over '
       + 'callTimeout', function () {
      circuit.callTimeout = 5e3;
      var promise = circuit.execute(() => Promise.resolve('Ok'))
               .catch(function (error) {
                 expect(error).to.be.an.instanceof(Promise.TimeoutError);
               });

      clock.tick(5e3);
      return promise;
    });

    it('Rejects all Promises with CircuitOpenError if state is OPEN', () => {
      circuit.open();
      return circuit.execute(() => Promise.resolve('this would have been ok'))
             .catch(function (error) {
               expect(error).to.be.an.instanceof(circuit.CircuitOpenError);
             });
    });

    it('Does not apply input function if state is OPEN', () => {
      circuit.open();
      var spy = sandbox.spy(pass);

      return circuit.execute(spy)
        .catch(() => 'noop')
        .finally(function (error) {
          sinon.assert.notCalled(spy);
        });
    });

    it('Makes one attempt when state is HALF_OPEN', function () {
      circuit.retryTimeout = 60e3;
      circuit.open();
      clock.tick(60e3);
      expect(circuit.state).to.equal('HALF_OPEN');

      return circuit.execute(() => Promise.resolve('Ok'))
             .then(function (value) {
               expect(value).to.equal('Ok');
             });
    });

    it('Rejects all Promises with CircuitOpenError if state is HALF_CLOSED',
       () => {
         circuit.halfClose();
         return circuit.execute(() => Promise.resolve('this would have been ok'))
           .catch(function (error) {
             expect(error).to.be.an.instanceof(circuit.CircuitOpenError);
           });
       });

    it('Does not apply input function if state is HALF_CLOSED', () => {
      circuit.halfClose();
      var spy = sandbox.spy(pass);

      return circuit.execute(spy)
        .catch(() => 'noop')
        .finally(function (error) {
          sinon.assert.notCalled(spy);
        });
    });

    it('Attempts to enter HALF_OPEN after HALF_CLOSED', () => {
      circuit.halfClose();
      circuit.errorCount = circuit.maxFailures + 1;

      sandbox.spy(circuit, 'halfOpenCheck');

      return circuit
        .execute(pass)
        .catch(() => {
          return new Promise(resolve => {
            setTimeout(resolve, 1000);
            clock.tick(1000);
          });
        })
        .then(() => {
          sinon.assert.calledOnce(circuit.halfOpenCheck);
        });
    });
  });

  describe('State Changes', () => {
    it('[CLOSED -> OPEN] state when failures go over max', function () {
      circuit.maxFailures = 0;
      return circuit.execute(() => Promise.reject(new Error(1)))
             .catch(function () {
               expect(circuit.state).to.equal('OPEN');
             });
    });

    it('[OPEN -> HALF_OPEN] after resetTimeout if halfOpenCheck passes', () => {
      circuit.resetTimeout = 5 * 60e3;
      circuit.open();

      expect(circuit.state).to.equal('OPEN');
      clock.tick(5 * 60e3);
      expect(circuit.state).to.equal('HALF_OPEN');
    });

    it('[OPEN -> OPEN] after resetTimeout if halfOpenCheck fails', () => {
      circuit.halfOpenCheck = () => Promise.resolve(false);
      circuit.resetTimeout = 5 * 60e3;
      var spy = sandbox.spy(circuit, 'halfOpenCheck');
      circuit.open();

      expect(circuit.state).to.equal('OPEN');
      clock.tick(5 * 60e3);
      sinon.assert.called(spy); // OPEN->OPEN could mean that nothing happened
      expect(circuit.state).to.equal('OPEN');
    });

    it('[OPEN -> OPEN] after resetTimeout if halfOpenCheck rejects', () => {
      circuit.halfOpenCheck = () => Promise.reject(new Error('TestingError'));
      circuit.resetTimeout = 5 * 60e3;
      var spy = sandbox.spy(circuit, 'halfOpenCheck');
      circuit.open().catch(() => 'no-op');

      expect(circuit.state).to.equal('OPEN');
      clock.tick(5 * 60e3);
      sinon.assert.called(spy); // OPEN->OPEN could mean that nothing happened
      expect(circuit.state).to.equal('OPEN');
    });

    it('[HALF_OPEN -> HALF_CLOSED] while retry is in flight', () => {
      circuit.halfOpen();

      expect(circuit.state).to.equal('HALF_OPEN');
      circuit.execute(() => Promise.resolve('Ok'));
      expect(circuit.state).to.equal('HALF_CLOSED');
    });

    it('[HALF_OPEN -> OPEN] if retry fails', () => {
      circuit.maxFailures = 0;
      circuit.halfOpen();

      expect(circuit.state).to.equal('HALF_OPEN');
      return circuit.execute(() => Promise.reject(new Error('Testing Error')))
        .catch(function () {
          expect(circuit.state).to.equal('OPEN');
        });
    });

    it('[HALF_OPEN -> HALF_CLOSED -> CLOSED] if retry succeeds', () => {
      circuit.halfOpen();

      expect(circuit.state).to.equal('HALF_OPEN');
      var p = circuit.execute(() => Promise.resolve('Ok'));
      expect(circuit.state).to.equal('HALF_CLOSED');

      return p.then(function () {
        expect(circuit.state).to.equal('CLOSED');
      });
    });
  });
});

describe('CircuitBreaker.open()', function () {
  var circuit;
  var sandbox;
  var clock;
  beforeEach(function () {
    sandbox = sinon.sandbox.create();
    clock = sandbox.useFakeTimers();
    circuit = new CircuitBreaker();
  });
  afterEach(function () {
    sandbox.restore();
  });

  it('Sets circuit.state to "OPEN"', function () {
    expect(circuit.state).to.equal('CLOSED');
    circuit.open();
    expect(circuit.state).to.equal('OPEN');
  });

  it('Uses exponential backoff (doubling) for attempting to close', () => {
    var initialResetTimeout = circuit.resetTimeout;
    circuit.open();
    expect(circuit.resetTimeout).to.equal(2 * initialResetTimeout);
    circuit.open();
    expect(circuit.resetTimeout).to.equal(4 * initialResetTimeout);
  });

  it('Exponential backof maxes out at circuit.maxResetTimeout', () => {
    var initialResetTimeout = circuit.resetTimeout;
    circuit.maxResetTimeout = initialResetTimeout + 1;
    circuit.open();
    expect(circuit.resetTimeout).to.equal(circuit.maxResetTimeout);
  });

  it('Calls circuit.halfOpenCheck after self.resetTimeout', () => {
    var spy = sinon.spy(circuit, 'halfOpenCheck');
    circuit.open();
    clock.tick(circuit.resetTimeout);
    sinon.assert.calledOnce(spy);
  });
});

describe('CircuitBreaker.close()', function () {
  var circuit;
  var sandbox;
  var clock;
  beforeEach(function () {
    sandbox = sinon.sandbox.create();
    clock = sandbox.useFakeTimers();
    circuit = new CircuitBreaker();
  });
  afterEach(function () {
    sandbox.restore();
  });

  it('Sets circuit.state to "CLOSED"', function () {
    circuit.open();
    expect(circuit.state).to.equal('OPEN');
    circuit.close();
    expect(circuit.state).to.equal('CLOSED');
  });

  it('Sets circuit.errorCount to 0', function () {
    circuit.errorCount = 10;
    expect(circuit.errorCount).to.equal(10);
    circuit.close();
    expect(circuit.errorCount).to.equal(0);
  });

  it('Initializes resetTimeout to minimum value', function () {
    circuit.resetTimeout = 5 * 60e3;
    circuit.close();
    expect(circuit.resetTimeout).to.equal(circuit.minResetTimeout);
  });
});


describe('Predicate Functions', function () {
  describe('errorMatch', function () {
    it('Does not add to errorCount if error does not match', () => {
      var circuit = new CircuitBreaker({
        errorMatch: (err) => (err.statusCode && err.statusCode >= 500)
      });

      var clientError = new Error('ClientError');
      clientError.statusCode = 400;
      var connectionError = new Error('ConnectionError');

      return circuit.execute(Promise.reject, clientError)
        .catch(function (err) {
          expect(err).to.match(/ClientError/);
          return circuit.execute(Promise.reject, connectionError);
        })
        .catch(function (err) {
          expect(err).to.match(/ConnectionError/);
        })
        .finally(function () {          
          expect(circuit.errorCount).to.equal(0);
        });
    });
  });
});
