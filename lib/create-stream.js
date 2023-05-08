const net = require('net');

module.exports = function createStream(opts) {
    if (opts.stream) return opts.stream;
    var host = opts.host;
    var port = opts.port;
    var socket = opts.socket;
    if (socket) return net.createConnection(socket);
    if (port) return net.createConnection(port, host);

    var busAddress = opts.busAddress || process.env.DBUS_SESSION_BUS_ADDRESS;
    if (!busAddress) throw new Error('unknown bus address');

    var addresses = busAddress.split(';');
    for (var i = 0; i < addresses.length; ++i) {
      var address = addresses[i];
      var familyParams = address.split(':');
      var family = familyParams[0];
      var params = {};
      familyParams[1].split(',').map(function(p) {
        var keyVal = p.split('=');
        params[keyVal[0]] = keyVal[1];
      });

      try {
        switch (family.toLowerCase()) {
          case 'tcp':
            host = params.host || 'localhost';
            port = params.port;
            return net.createConnection(port, host);
          case 'unix':
            if (params.socket) return net.createConnection(params.socket);
            if (params.path) return net.createConnection(params.path);
            throw new Error(
              "not enough parameters for 'unix' connection - you need to specify 'socket' or 'path' parameter"
            );
          case 'unixexec':
            var eventStream = require('event-stream');
            var spawn = require('child_process').spawn;
            var args = [];
            for (var n = 1; params['arg' + n]; n++) args.push(params['arg' + n]);
            var child = spawn(params.path, args);

            return eventStream.duplex(child.stdin, child.stdout);
          default:
            throw new Error('unknown address type:' + family);
        }
      } catch (e) {
        if (i < addresses.length - 1) {
          console.warn(e.message);
          continue;
        } else {
          throw e;
        }
      }
    }
  }