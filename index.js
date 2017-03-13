'use strict';

var Promise = require('bluebird');
var EventEmitter = require('events').EventEmitter;
var util = require('util');
var debug = util.debuglog('circuit');

function CircuitBreaker (opts) {
  var self = this;
  opts = opts || {};
  EventEmitter.call(this, opts);

  this.maxFailures = opts.maxFailures === undefined
                   ? 5
                   : opts.maxFailures;

  // resetTimeout :: The amount of time to wait after tripping the
  // circuit before trying to close it. (In milliseconds.)
  this.minResetTimeout = Math.max( 1, opts.resetTimeout || 500);
  this.maxResetTimeout = opts.maxResetTimeout || 5 * 60e3;
  this.resetTimeout = this.minResetTimeout;

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

  Object.defineProperty(this, '_state', {enumerable: false});

  Object.defineProperty(this, 'state', {
    enumerable: true,
    configurable: false,
    get: function () {
      return self._state;
    },
    set: function () { throw new TypeError('You cannot set state directly'); }
  });
}

util.inherits(CircuitBreaker, EventEmitter);

CircuitBreaker.prototype.inspect = function () {
  return {
    state: this.state,
    errorHandling: {
      current: this.errorCount,
      max: this.maxFailures
    },
    resetTimeout: {
      min: this.minResetTimeout,
      current: this.resetTimeout,
      max: this.maxResetTimeout
    }
  };
};

CircuitBreaker.prototype.open = function () {
  debug('open');
  var self = this;
  this._state = 'OPEN';
  this.emit('open');
  this.resetTimeout = Math.min(this.maxResetTimeout,
                               this.resetTimeout * 2);

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
           return self.onError(err);
         });
};

CircuitBreaker.prototype.close = function () {
  debug('close');
  this._state = 'CLOSED';
  this.errorCount = 0;
  this.resetTimeout = this.minResetTimeout;
  this.emit('close');
};

CircuitBreaker.prototype.halfOpen = function () {
  debug('halfOpen');
  this._state = 'HALF_OPEN';
  this.emit('halfOpen');
};

CircuitBreaker.prototype.halfClose = function () {
  debug('halfClose');
  this._state = 'HALF_CLOSED';
  this.emit('halfClose');
};

CircuitBreaker.prototype.execute = function (fn) {
  debug('execute(%s): %d - %d', this._state, this.maxFailures, this.errorCount);
  var self = this;
  var args = Array.prototype.slice.call(arguments, 1);

  switch (self.state) {
  case 'OPEN':
  case 'HALF_CLOSED':
    return Promise.reject(new this.CircuitOpenError());

  case 'HALF_OPEN':
    this.halfClose();
    return Promise.resolve(fn.apply(null, args)).timeout(self.callTimeout)
           .then(function closeAndResolve (value) {
             debug('closeAndResolve');
             self.close();
             return value;
           })
           .catch(self.onError.bind(self));

  case 'CLOSED':
  default:
    return Promise.resolve(fn.apply(null, args)).timeout(self.callTimeout)
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
  debug('Default halfOpenCheck');
  return Promise.resolve(true);
};

CircuitBreaker.prototype.onError = function (error) {
  debug('onError');
  if (this.errorMatch(error)
    && !this.errorIgnore(error)
    && ++this.errorCount > this.maxFailures) {
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
