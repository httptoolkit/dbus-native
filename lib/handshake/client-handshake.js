const Buffer = require('safe-buffer').Buffer;

const constants = require('../constants');
const readLine = require('./readline');
const doCookieAuth = require('./cookie-auth');

function hexlify(input) {
  return Buffer.from(input.toString(), 'ascii').toString('hex');
}

module.exports = function auth(stream, opts, cb) {
  // filter used to make a copy so we don't accidently change opts data
  var authMethods;
  if (opts.authMethods) {
    authMethods = opts.authMethods;
  } else {
    authMethods = constants.defaultAuthMethods;
  }
  const skipAuthentication = authMethods.length === 0;
  if (skipAuthentication) {
    setTimeout(() => { cb(null, null); }, 0);
    return;
  }
  stream.write('\0');
  tryAuth(stream, authMethods.slice(), cb);
};

function tryAuth(stream, methods, cb) {
  if (methods.length === 0) {
    return cb(new Error('No authentication methods left to try'));
  }

  var authMethod = methods.shift();
  var uid = process.hasOwnProperty('getuid') ? process.getuid() : 0;
  var id = hexlify(uid);

  function beginOrNextAuth() {
    readLine(stream, function(line) {
      var ok = line.toString('ascii').match(/^([A-Za-z]+) (.*)/);
      if (ok && ok[1] === 'OK') {
        stream.write('BEGIN\r\n');
        return cb(null, ok[2]); // ok[2] = guid. Do we need it?
      } else {
        // TODO: parse error!
        if (!methods.empty) {
          tryAuth(stream, methods, cb);
        } else {
          return cb(line);
        }
      }
    });
  }

  switch (authMethod) {
    case 'EXTERNAL':
      stream.write(`AUTH ${authMethod} ${id}\r\n`);
      beginOrNextAuth();
      break;
    case 'DBUS_COOKIE_SHA1':
      doCookieAuth(stream, id, beginOrNextAuth);
      break;
    case 'ANONYMOUS':
      stream.write('AUTH ANONYMOUS \r\n');
      beginOrNextAuth();
      break;
    default:
      console.error(`Unsupported auth method: ${authMethod}`);
      beginOrNextAuth();
      break;
  }
}
