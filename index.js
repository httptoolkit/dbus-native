// dbus.freedesktop.org/doc/dbus-specification.html

const EventEmitter = require('events').EventEmitter;

const constants = require('./lib/constants');
const message = require('./lib/message');
const clientHandshake = require('./lib/handshake');
const serverHandshake = require('./lib/server-handshake');
const MessageBus = require('./lib/bus');
const server = require('./lib/server');
const createStream = require('./lib/create-stream');

function createConnection(opts) {
  var self = new EventEmitter();
  if (!opts) opts = {};
  var stream = (self.stream = createStream(opts));
  if (stream.setNoDelay) stream.setNoDelay();

  stream.on('error', function(err) {
    // forward network and stream errors
    self.emit('error', err);
  });

  stream.on('end', function() {
    self.emit('end');
    self.message = function() {
      throw new Error("Can't write a message to a closed stream");
    };
  });

  self.end = function() {
    stream.end();
    return self;
  };

  var handshake = opts.server ? serverHandshake : clientHandshake;
  handshake(stream, opts, function(error, guid) {
    if (error) {
      return self.emit('error', error);
    }
    self.guid = guid;
    self.emit('connect');
    message.unmarshalMessages(
      stream,
      function(message) {
        self.emit('message', message);
      },
      opts
    );
  });

  self._messages = [];

  // pre-connect version, buffers all messages. replaced after connect
  self.message = function(msg) {
    self._messages.push(msg);
  };

  self.once('connect', function() {
    self.state = 'connected';
    for (var i = 0; i < self._messages.length; ++i) {
      stream.write(message.marshall(self._messages[i]));
    }
    self._messages.length = 0;

    // no need to buffer once connected
    self.message = function(msg) {
      stream.write(message.marshall(msg));
    };
  });

  return self;
}

module.exports.createClient = function(params) {
  var connection = createConnection(params || {});
  return new MessageBus(connection, params || {});
};

module.exports.systemBus = function() {
  return module.exports.createClient({
    busAddress:
      process.env.DBUS_SYSTEM_BUS_ADDRESS ||
      'unix:path=/var/run/dbus/system_bus_socket'
  });
};

module.exports.sessionBus = function(opts) {
  return module.exports.createClient(opts);
};

module.exports.messageType = constants.messageType;
module.exports.createConnection = createConnection;

module.exports.createServer = server.createServer;
