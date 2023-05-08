module.exports = function createStream(opts) {
    if (!opts.stream) {
      throw new Error('D-Bus browser connections must be created with an existing stream');
    }

    return opts.stream;
  }