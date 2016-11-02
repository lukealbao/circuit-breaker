'use strict';

var Promise = require('bluebird');
var EventEmitter = require('events').EventEmitter;
var util = require('util');

function CircuitBreaker (opts) {
  opts = opts || {};
  EventEmitter.call(this, opts);
  
  this.maxFailures = opts.maxFailures || 5;

  // resetTimeout :: The amount of time to wait after tripping the
  // circuit before trying to close it.
  this.resetTimeout = opts.resetTimeout || 1 * 60e3;

  // callTimeout :: The amount of time an operation should wait
  // before being considered an error.
  this.callTimeout = opts.callTimeout || 5e3;

  this.close();

  // Error predicates: If you want to only use certain types of
  // errors to trip the breaker, include predicates in the options.
  if (typeof opts.errorMatch === 'function') {
    this.errorMatch = opts.errorMatch;
  }
  if (typeof opts.errorIgnore === 'function') {
    this.errorIgnore = opts.errorIgnore;
  }

  // Half-open predicate: If you want to perform any additional
  // checks before transitioning from OPEN to HALF_OPEN, include it in
  // the constructor options. Function should return a Promise that
  // resolves a Boolean.
  if (typeof opts.halfOpenCheck === 'function') {
    this.halfOpenCheck = opts.halfOpenCheck;
  }
}

util.inherits(CircuitBreaker, EventEmitter);

Object.defineProperty(CircuitBreaker.prototype, 'state', {
  get: function () { return this._state; },
  set: function () { throw new TypeError('You cannot set state directly'); }
});

CircuitBreaker.prototype._states = {
  CLOSED: 0,
  OPEN: 1,
  HALF_OPEN: 2,
  HALF_CLOSED: 3
};

CircuitBreaker.prototype.open = function () {
  var self = this;
  this._state = this._states.OPEN;
  this.emit('open');

  return Promise.delay(self.resetTimeout)
         .then(function () {
           return Promise.try(self.halfOpenCheck);
         })
         .then(function (ok) {
           // Any implementation of halfOpenCheck should return
           // a Boolean indicating whether we should transition
           // to HALF_OPEN.
           
           if (ok) {
             return self.halfOpen();
           } else {
             return self.open();
           }
         })
         .catch(function (err) {
           self.emit('error', err);
           return self.open();
         });
};

CircuitBreaker.prototype.close = function () {
  this._state = this._states.CLOSED;
  this.errorCount = 0;
  this.emit('close');
};

CircuitBreaker.prototype.halfOpen = function () {
  this._state = this._states.HALF_OPEN;
  this.emit('halfOpen');
};

CircuitBreaker.prototype.halfClose = function () {
  this._state = this._states.HALF_CLOSED;
  this.emit('halfClose');
};

CircuitBreaker.prototype.execute = function (promise) {
  var self = this;

  switch (self.state) {
  case self._states.OPEN:
  case self._states.HALF_CLOSED:
    return Promise.reject(new this.CircuitOpenError());

  case this._states.HALF_OPEN:
    this.halfClose();
    return promise.timeout(self.callTimeout)
           .then(function closeAndResolve (value) {
             self.close();
             return value;
           })
           .catch(self.onError.bind(self));

  case this._states.CLOSED:
  default:
    return promise.timeout(self.callTimeout)
           .catch(self.onError.bind(self));
  }
};

CircuitBreaker.prototype.errorMatch = function (error) { // eslint-disable-line no-unused-vars
  // Predicate function to allow only certain errors to trip breaker.
  // By default, all will do so.
  return true;
};

CircuitBreaker.prototype.errorIgnore = function (error) { // eslint-disable-line no-unused-vars
  // Predicate function to disallow certain errors from tripping breaker.
  // By default, all will do so.
  return false;
};

CircuitBreaker.prototype.halfOpenCheck = function () {
  // Abstract predicate that determines state change from OPEN to HALF_OPEN.
  // Any overwriting methods should return a Promise that resolves a boolean,
  // which should be interpreted as, "Should we transition to HALF_OPEN?"
  //
  // By default, any resetTimeout will transition to HALF_OPEN.
  return Promise.resolve(true);
};

CircuitBreaker.prototype.onError = function (error) {
  if (++this.errorCount > this.maxFailures
    && this.errorMatch(error)
    && !this.errorIgnore(error)) {
    this.open();
  }

  throw error;
};

CircuitBreaker.prototype.CircuitOpenError = function CircuitOpenError () {
  Error.captureStackTrace(this, CircuitOpenError);
  this.message = 'Circuit breaker is open';
};
util.inherits(CircuitBreaker.prototype.CircuitOpenError, Error);

module.exports = CircuitBreaker;
