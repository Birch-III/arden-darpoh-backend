// Wraps an async route handler so any rejected promise is passed to
// Express's error handler instead of crashing the process.
module.exports = function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
