# Circuit Breaker

## Public API
This repository exports a constructor function for the CircuitBreaker
type. A circuit breaker should encapsulate a single integration
point - usually a database or a remote service - and it should be
registered at the application level. That is, the state of a circuit
breaker should be consistent across all consumers of the integration
point.

## Constructor

The constructor accepts an optional object containing the following
options:

|**Option**|**Description**|**Default value**|
|----------|----------|----------|
|maxFailures|The number of errors that trips the circuit|5|
|resetTimeout|Initial timeout to wait before attempting to close an open circuit (in ms)|500|
|callTimeout|Amount of time each operation should be allowed before rejecting as a timeout (in ms)|5000|
|errorMatch|Predicate function to match handle only certain errors| `() => true`|
|errorIgnore|Predicate function to ignore certain errors| `() => false`|
|halfOpenCheck|Promise-returning predicate function to enter half-open state|`() => true`|

The `errorMatch` and `errorIgnore` functions can be included at
construction time. When an operation rejects, the resolved error will
be passed to each of these functions. This way, you can add
granularity to the circuit. For example, you might be wrapping an HTTP
integration and want to only break on 5xx errors while letting 4xx
errors fail without opening the circuit. By default, all errors will
contribute to circuit breaker behavior.

The `halfOpenCheck` predicate can be used for adding external
constraints before attempting to close the circuit. For example, an
open circuit might fill a queue with messages that must be resent once
the circuit is restored. In this case, it might be useful to keep the
circuit open until the queue has been emptied and the system is in a
consistent state. 

A `halfOpenCheck` predicate must be a function that returns a
Promise. If the promise resolves `true`, then the circuit will attempt
to enter half-open state. If it resolves `false` or rejects with an
error, then the circuit will remain open.

## Usage

```javascript
var request = require('request-promise');

var circuit = new CircuitBreaker({
  errorMatch: function (err) {
    return err.statusCode && err.statusCode >= 500;
  }
});

// Variadic usage
circuit.execute(request, 'http://google.com')
.then(function (res) {
  console.log(res.body);
})
.catch(function (err) {
  console.error(err);
});

// Single callback usage
circuit.execute(function () {
  return request('http://google.com');
})
.then(function (res) {
  console.log(res.body);
})
.catch(function (err) {
  console.error(err);
});
```

Simply wrap your I/O calls in a call to `circuit.execute`. When the
underlying I/O call fails, the error will bubble to the
`circuit.execute` wrapper. As a result, error handling is the same
as operation without a circuit breaker. When the circuit is in an open
state, it will reject all calls, and they will pass through the same
catch blocks.

#### Syntax
Due to Javascript's evaluation methods, it's necessary to defer the
call to the wrapped I/O function until after the circuit's state has
been checked. There are two equivalent syntaxes for achieving this:

- **Variadic:** You can pass in a reference to the promise-returning
  I/O function as the first argument to `circuit.execute`, and it will
  be applied to any subsequent arguments.
- **Single callback:** You can also pass a single callback function to
  `circuit.execute`. The callback should _return_ the result of
  calling the promise-returning function.
