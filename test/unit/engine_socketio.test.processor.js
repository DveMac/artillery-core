const noop = () => {};

module.exports = {
  flowBeforeRequest: noop,
  emitBeforeRequest: noop,
  flowAfterResponse: noop,
  emitAfterResponse: noop,
};
