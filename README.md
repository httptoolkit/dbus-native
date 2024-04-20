# @httptoolkit/dbus-native [![Build Status](https://github.com/httptoolkit/dbus-native/workflows/CI/badge.svg)](https://github.com/httptoolkit/dbus-native/actions)

> _Part of [HTTP Toolkit](https://httptoolkit.com): powerful tools for building, testing & debugging HTTP(S)_

Pure JS D-Bus protocol client & server for browsers and Node.js.

This is a fork of [dbus-native](https://github.com/sidorares/dbus-native), aiming to extend it for use in [frida-js](https://github.com/httptoolkit/frida-js/) and [HTTP Toolkit](https://github.com/httptoolkit/httptoolkit/) with:

* Support for browser usage via WebSocket connections, in addition to Node.js
* Support for skipping handshake authentication (as used by Frida)
* Support for connecting via non-socket streams (as used by Frida's WebSocket API)
* Type definitions included (and likely converting entirely to TypeScript in future)
* Modernization:
   * Automated testing via GitHub Actions
   * Promises everywhere
   * Dropping support for engines before Node v16 (ES2022)
   * Replaced xml2js with fast-xml-parser (faster, smaller, better browser compat)
* Simplification:
   * Dropped bin scripts
   * Dropped various unused files
   * Dropped examples
* Improved error handling:
   * Throws an explicit error when sending a message to a closed stream, instead of silently never responding
   * Turn D-Bus error responses into proper error instances where possible (rather than throwing arrays of strings)

Installation
------------

```shell
npm install @httptoolkit/dbus-native
```

Usage
------

Short example using desktop notifications service

```js
const dbus = require('@httptoolkit/dbus-native');
const sessionBus = dbus.sessionBus();
sessionBus.getService('org.freedesktop.Notifications').getInterface(
    '/org/freedesktop/Notifications',
    'org.freedesktop.Notifications', function(err, notifications) {

    // dbus signals are EventEmitter events
    notifications.on('ActionInvoked', function() {
        console.log('ActionInvoked', arguments);
    });
    notifications.on('NotificationClosed', function() {
        console.log('NotificationClosed', arguments);
    });
    notifications.Notify('exampl', 0, '', 'summary 3', 'new message text', ['xxx yyy', 'test2', 'test3', 'test4'], [],  5, function(err, id) {
       //setTimeout(function() { n.CloseNotification(id, console.log); }, 4000);
    });
});
```

API
---

### Low level messaging: bus connection

`connection = dbus.createClient(options)`

options:
   - socket - unix socket path
   - port - TCP port
   - host - TCP host
   - busAddress - encoded bus address. Default is `DBUS_SESSION_BUS_ADDRESS` environment variable. See http://dbus.freedesktop.org/doc/dbus-specification.html#addresses
   - authMethods - array of authentication methods, which are attempted in the order provided (default:['EXTERNAL', 'DBUS_COOKIE_SHA1', 'ANONYMOUS'])
   - ayBuffer - boolean (default:true): if true 'ay' dbus fields are returned as buffers
   - ReturnLongjs - boolean (default:false): if true 64 bit dbus fields (x/t) are read out as Long.js objects, otherwise they are converted to numbers (which should be good up to 53 bits)
   - ( TODO: add/document option to use adress from X11 session )

connection has only one method, `message(msg)`

message fields:
   - type - methodCall, methodReturn, error or signal
   - path - object path
   - interface
   - destination
   - sender
   - member
   - serial
   - signature
   - body
   - errorName
   - replySerial

connection signals:
   - connect - emitted after successful authentication
   - message
   - error

example:

```js
const dbus = require('@httptoolkit/dbus-native');
const conn = dbus.createConnection();
conn.message({
    path:'/org/freedesktop/DBus',
    destination: 'org.freedesktop.DBus',
    'interface': 'org.freedesktop.DBus',
    member: 'Hello',
    type: dbus.messageType.methodCall
});
conn.on('message', function(msg) { console.log(msg); });
```

### Note on INT64 'x' and UINT64 't'
Long.js is used for 64 Bit support. https://github.com/dcodeIO/long.js
The following javascript types can be marshalled into 64 bit dbus fields:
   - typeof 'number' up to 53bits
   - typeof 'string' (consisting of decimal digits with no separators or '0x' prefixed hexadecimal) up to full 64bit range
   - Long.js objects (or object with compatible properties)

By default 64 bit dbus fields are unmarshalled into a 'number' (with precision loss beyond 53 bits). Use {ReturnLongjs:true} option to return the actual Long.js object and preserve the entire 64 bits.

### Links
   - http://cgit.freedesktop.org/dbus - freedesktop reference C library
   - https://github.com/guelfey/go.dbus
   - https://github.com/Shouqun/node-dbus - libdbus
   - https://github.com/Motorola-Mobility/node-dbus - libdbus
   - https://github.com/izaakschroeder/node-dbus - libdbus
   - https://github.com/agnat/node_libdbus
   - https://github.com/agnat/node_dbus - native js
   - https://github.com/cocagne/txdbus - native python + twisted
   - http://search.cpan.org/~danberr/Net-DBus-1.0.0/ (seems to be native, but requires libdbus?)
   - https://github.com/mvidner/ruby-dbus (native, sync)
   - http://www.ndesk.org/DBusSharp (C#/Mono)
   - https://github.com/lizenn/erlang-dbus/ - erlang
   - https://github.com/mspanc/dbux/ - elixir
   - http://0pointer.net/blog/the-new-sd-bus-api-of-systemd.html - Blog post about sb-bus and D-Bus in general
