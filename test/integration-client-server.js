const assert = require('assert');
const net = require('net');
const dbus = require('../');
const constants = require('../lib/constants');

// Create a pair of connected MessageBus instances over TCP.
// Both skip authentication and the Hello handshake.
function createBusPair(callback) {
  var clientBus, serverBus;
  var readyCount = 0;

  function checkReady() {
    readyCount++;
    if (readyCount === 2) {
      callback(clientBus, serverBus);
    }
  }

  var tcpServer = net.createServer(function(serverSocket) {
    tcpServer.close();
    serverBus = dbus.createClient({
      stream: serverSocket,
      authMethods: [],
      direct: true
    });
    serverBus.connection.once('connect', checkReady);
  });

  tcpServer.listen(0, '127.0.0.1', function() {
    var clientSocket = net.createConnection({
      port: tcpServer.address().port,
      host: '127.0.0.1'
    });
    clientBus = dbus.createClient({
      stream: clientSocket,
      authMethods: [],
      direct: true
    });
    clientBus.connection.once('connect', checkReady);
  });
}

// Clean up connections
function cleanup(bus1, bus2, done) {
  var ended = 0;
  function check() {
    ended++;
    if (ended === 2) done();
  }
  bus1.connection.stream.on('close', check);
  bus2.connection.stream.on('close', check);
  bus1.connection.end();
  bus2.connection.end();
}

describe('client-server integration', function() {

  it('can send a method call and receive a method return', function(done) {
    createBusPair(function(client, server) {
      var iface = {
        name: 'org.example.Iface',
        methods: { Ping: ['s', 's'] }
      };

      server.exportInterface({
        Ping: function(arg) { return 'pong:' + arg; }
      }, '/org/example/Obj', iface);

      client.invoke({
        path: '/org/example/Obj',
        interface: 'org.example.Iface',
        member: 'Ping',
        signature: 's',
        body: ['hello']
      }, function(err, reply) {
        assert.ifError(err);
        assert.strictEqual(reply, 'pong:hello');
        cleanup(client, server, done);
      });
    });
  });

  it('can send a method call and receive an error response', function(done) {
    createBusPair(function(client, server) {
      var iface = {
        name: 'org.example.Iface',
        methods: { Fail: ['s', 's'] }
      };

      server.exportInterface({
        Fail: function() {
          var err = new Error('Resource not found');
          err.dbusName = 'org.example.Error.NotFound';
          throw err;
        }
      }, '/org/example/Obj', iface);

      client.invoke({
        path: '/org/example/Obj',
        interface: 'org.example.Iface',
        member: 'Fail',
        signature: 's',
        body: ['missing-id']
      }, function(err) {
        assert.ok(err, 'should receive an error');
        assert.ok(err.message.includes('Resource not found'),
          'error message should be forwarded');
        cleanup(client, server, done);
      });
    });
  });

  it('can send and receive signals', function(done) {
    createBusPair(function(client, server) {
      var signalKey = JSON.stringify({
        path: '/org/example/Obj',
        interface: 'org.example.Iface',
        member: 'SomethingChanged'
      });

      client.signals.on(signalKey, function(body) {
        assert.deepStrictEqual(body, ['new-value']);
        cleanup(client, server, done);
      });

      server.sendSignal(
        '/org/example/Obj',
        'org.example.Iface',
        'SomethingChanged',
        's',
        ['new-value']
      );
    });
  });

  it('handles multiple sequential method calls correctly', function(done) {
    createBusPair(function(client, server) {
      var iface = {
        name: 'org.example.Math',
        methods: { Increment: ['u', 'u'] }
      };

      server.exportInterface({
        Increment: function(n) { return n + 1; }
      }, '/obj', iface);

      var completed = 0;
      function checkDone() {
        completed++;
        if (completed === 5) cleanup(client, server, done);
      }

      for (var i = 0; i < 5; i++) {
        (function(n) {
          client.invoke({
            path: '/obj',
            interface: 'org.example.Math',
            member: 'Increment',
            signature: 'u',
            body: [n]
          }, function(err, result) {
            assert.ifError(err);
            assert.strictEqual(result, n + 1);
            checkDone();
          });
        })(i);
      }
    });
  });

  it('handles method calls with dict argument types', function(done) {
    createBusPair(function(client, server) {
      var iface = {
        name: 'org.example.Config',
        methods: { GetKeys: ['a{su}', 'u'] }
      };

      server.exportInterface({
        GetKeys: function(dict) {
          // dict is an array of [key, value] pairs; sum the values
          var sum = 0;
          for (var i = 0; i < dict.length; i++) {
            sum += dict[i][1];
          }
          return sum;
        }
      }, '/obj', iface);

      client.invoke({
        path: '/obj',
        interface: 'org.example.Config',
        member: 'GetKeys',
        signature: 'a{su}',
        body: [[['a', 10], ['b', 20], ['c', 30]]]
      }, function(err, result) {
        assert.ifError(err);
        assert.strictEqual(result, 60);
        cleanup(client, server, done);
      });
    });
  });

  it('handles byte array transfer', function(done) {
    createBusPair(function(client, server) {
      var iface = {
        name: 'org.example.Data',
        methods: { Echo: ['ay', 'ay'] }
      };

      server.exportInterface({
        Echo: function(data) { return data; }
      }, '/obj', iface);

      var data = Buffer.from([0x00, 0x01, 0x02, 0xFE, 0xFF]);

      client.invoke({
        path: '/obj',
        interface: 'org.example.Data',
        member: 'Echo',
        signature: 'ay',
        body: [data]
      }, function(err, result) {
        assert.ifError(err);
        assert.ok(Buffer.isBuffer(result), 'byte array should be returned as Buffer');
        assert.ok(data.equals(result), 'byte array should round-trip correctly');
        cleanup(client, server, done);
      });
    });
  });

  it('handles signals with no body', function(done) {
    createBusPair(function(client, server) {
      var signalKey = JSON.stringify({
        path: '/org/example/Obj',
        interface: 'org.example.Iface',
        member: 'Ping'
      });

      client.signals.on(signalKey, function(body) {
        cleanup(client, server, done);
      });

      server.connection.message({
        type: constants.messageType.signal,
        serial: server.serial++,
        path: '/org/example/Obj',
        interface: 'org.example.Iface',
        member: 'Ping'
      });
    });
  });

  it('handles exported interface with method calls', function(done) {
    createBusPair(function(client, server) {
      var iface = {
        name: 'org.example.Calculator',
        methods: {
          Add: ['uu', 'u']
        }
      };

      server.exportInterface({
        Add: function(a, b) { return a + b; }
      }, '/org/example/Calculator', iface);

      client.invoke({
        path: '/org/example/Calculator',
        interface: 'org.example.Calculator',
        member: 'Add',
        signature: 'uu',
        body: [17, 25]
      }, function(err, result) {
        assert.ifError(err);
        assert.strictEqual(result, 42);
        cleanup(client, server, done);
      });
    });
  });

  it('exported interface method that throws returns a D-Bus error', function(done) {
    createBusPair(function(client, server) {
      var iface = {
        name: 'org.example.Service',
        methods: { Fail: ['', 's'] }
      };

      server.exportInterface({
        Fail: function() {
          var err = new Error('Something went wrong');
          err.dbusName = 'org.example.Error.Failed';
          throw err;
        }
      }, '/org/example/Service', iface);

      client.invoke({
        path: '/org/example/Service',
        interface: 'org.example.Service',
        member: 'Fail'
      }, function(err) {
        assert.ok(err, 'should receive an error');
        assert.ok(err.message.includes('Something went wrong'));
        cleanup(client, server, done);
      });
    });
  });

  it('exported interface async method works', function(done) {
    createBusPair(function(client, server) {
      var iface = {
        name: 'org.example.Async',
        methods: { DelayedGreet: ['s', 's'] }
      };

      server.exportInterface({
        DelayedGreet: function(name) {
          return new Promise(function(resolve) {
            setTimeout(function() {
              resolve('Hello, ' + name + '!');
            }, 10);
          });
        }
      }, '/org/example/Async', iface);

      client.invoke({
        path: '/org/example/Async',
        interface: 'org.example.Async',
        member: 'DelayedGreet',
        signature: 's',
        body: ['World']
      }, function(err, result) {
        assert.ifError(err);
        assert.strictEqual(result, 'Hello, World!');
        cleanup(client, server, done);
      });
    });
  });

  it('bidirectional communication works', function(done) {
    createBusPair(function(bus1, bus2) {
      var iface = {
        name: 'org.example.Echo',
        methods: { Echo: ['s', 's'] }
      };

      bus1.exportInterface({
        Echo: function(msg) { return 'bus1:' + msg; }
      }, '/echo', iface);

      bus2.exportInterface({
        Echo: function(msg) { return 'bus2:' + msg; }
      }, '/echo', iface);

      var completed = 0;
      function checkDone() {
        completed++;
        if (completed === 2) cleanup(bus1, bus2, done);
      }

      bus1.invoke({
        path: '/echo',
        interface: 'org.example.Echo',
        member: 'Echo',
        signature: 's',
        body: ['hello']
      }, function(err, result) {
        assert.ifError(err);
        assert.strictEqual(result, 'bus2:hello');
        checkDone();
      });

      bus2.invoke({
        path: '/echo',
        interface: 'org.example.Echo',
        member: 'Echo',
        signature: 's',
        body: ['world']
      }, function(err, result) {
        assert.ifError(err);
        assert.strictEqual(result, 'bus1:world');
        checkDone();
      });
    });
  });

  it('calling unknown method returns D-Bus error', function(done) {
    createBusPair(function(client, server) {
      client.invoke({
        path: '/nonexistent',
        interface: 'org.example.Nope',
        member: 'Missing'
      }, function(err) {
        assert.ok(err, 'should receive an error for unknown method');
        cleanup(client, server, done);
      });
    });
  });

  it('handles string arguments with special characters', function(done) {
    createBusPair(function(client, server) {
      var iface = {
        name: 'org.example.Echo',
        methods: { Echo: ['s', 's'] }
      };

      server.exportInterface({
        Echo: function(s) { return s; }
      }, '/obj', iface);

      var testString = '\u00e9\u00e8\u00ea \u2603 \ud83d\ude00 "quotes" & <xml>';

      client.invoke({
        path: '/obj',
        interface: 'org.example.Echo',
        member: 'Echo',
        signature: 's',
        body: [testString]
      }, function(err, result) {
        assert.ifError(err);
        assert.strictEqual(result, testString);
        cleanup(client, server, done);
      });
    });
  });

  it('handles array of structs end-to-end', function(done) {
    createBusPair(function(client, server) {
      var iface = {
        name: 'org.example.Registry',
        methods: { CountEntries: ['a(su)', 'u'] }
      };

      server.exportInterface({
        CountEntries: function(entries) {
          return entries.length;
        }
      }, '/obj', iface);

      client.invoke({
        path: '/obj',
        interface: 'org.example.Registry',
        member: 'CountEntries',
        signature: 'a(su)',
        body: [[['alice', 1], ['bob', 2], ['charlie', 3]]]
      }, function(err, result) {
        assert.ifError(err);
        assert.strictEqual(result, 3);
        cleanup(client, server, done);
      });
    });
  });

  it('handles boolean and integer args end-to-end', function(done) {
    createBusPair(function(client, server) {
      var iface = {
        name: 'org.example.Logic',
        methods: { And: ['bb', 'b'] }
      };

      server.exportInterface({
        And: function(a, b) { return a && b; }
      }, '/obj', iface);

      var completed = 0;
      function checkDone() {
        completed++;
        if (completed === 3) cleanup(client, server, done);
      }

      client.invoke({
        path: '/obj', interface: 'org.example.Logic',
        member: 'And', signature: 'bb', body: [true, true]
      }, function(err, result) {
        assert.ifError(err);
        assert.strictEqual(result, true);
        checkDone();
      });

      client.invoke({
        path: '/obj', interface: 'org.example.Logic',
        member: 'And', signature: 'bb', body: [true, false]
      }, function(err, result) {
        assert.ifError(err);
        assert.strictEqual(result, false);
        checkDone();
      });

      client.invoke({
        path: '/obj', interface: 'org.example.Logic',
        member: 'And', signature: 'bb', body: [false, false]
      }, function(err, result) {
        assert.ifError(err);
        assert.strictEqual(result, false);
        checkDone();
      });
    });
  });

  it('handles double precision floating point end-to-end', function(done) {
    createBusPair(function(client, server) {
      var iface = {
        name: 'org.example.Math',
        methods: { Multiply: ['dd', 'd'] }
      };

      server.exportInterface({
        Multiply: function(a, b) { return a * b; }
      }, '/obj', iface);

      client.invoke({
        path: '/obj',
        interface: 'org.example.Math',
        member: 'Multiply',
        signature: 'dd',
        body: [3.14159, 2.0]
      }, function(err, result) {
        assert.ifError(err);
        assert.strictEqual(result, 3.14159 * 2.0);
        cleanup(client, server, done);
      });
    });
  });
});
