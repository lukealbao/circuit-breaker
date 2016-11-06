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
      expect(circuit.state).to.equal(circuit._states.HALF_OPEN);
      
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

  });

  describe('State Changes', () => {
    it('[CLOSED -> OPEN] state when failures go over max', function () {
      circuit.maxFailures = 0;
      return circuit.execute(() => Promise.reject(new Error(1)))
             .catch(function () {
               expect(circuit.state).to.equal(circuit._states.OPEN);
             });
    });

    it('[OPEN -> HALF_OPEN] after resetTimeout', () => {
      circuit.resetTimeout = 5 * 60e3;
      circuit.open();

      expect(circuit.state).to.equal(circuit._states.OPEN);
      clock.tick(5 * 60e3);
      expect(circuit.state).to.equal(circuit._states.HALF_OPEN);
    });

    it('[HALF_OPEN -> HALF_CLOSED] while retry is in flight', () => {
      circuit.halfOpen();

      expect(circuit.state).to.equal(circuit._states.HALF_OPEN);
      circuit.execute(() => Promise.resolve('Ok'));
      expect(circuit.state).to.equal(circuit._states.HALF_CLOSED);
    });

    it('[HALF_OPEN -> OPEN] if retry fails', () => {
      circuit.maxFailures = 0;
      circuit.halfOpen();

      expect(circuit.state).to.equal(circuit._states.HALF_OPEN);
      return circuit.execute(() => Promise.reject(new Error('Testing Error')))
        .catch(function () {
          expect(circuit.state).to.equal(circuit._states.OPEN);
        });
    });

    it('[HALF_OPEN -> HALF_CLOSED -> CLOSED] if retry succeeds', () => {
      circuit.halfOpen();

      expect(circuit.state).to.equal(circuit._states.HALF_OPEN);
      var p = circuit.execute(() => Promise.resolve('Ok'));
      expect(circuit.state).to.equal(circuit._states.HALF_CLOSED);

      return p.then(function () {
        expect(circuit.state).to.equal(circuit._states.CLOSED);
      });
    });
  });
});
