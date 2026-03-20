module.exports = function Put() {
  var chunks = [];

  return {
    put: function (buf) {
      chunks.push(buf);
      return this;
    },

    word8: function (x) {
      var buf = Buffer.alloc(1);
      buf.writeUInt8(x, 0);
      chunks.push(buf);
      return this;
    },

    word16le: function (x) {
      var buf = Buffer.alloc(2);
      buf.writeUInt16LE(x, 0);
      chunks.push(buf);
      return this;
    },

    word32le: function (x) {
      var buf = Buffer.alloc(4);
      buf.writeUInt32LE(x >>> 0, 0);
      chunks.push(buf);
      return this;
    },

    buffer: function () {
      return Buffer.concat(chunks);
    }
  };
};
