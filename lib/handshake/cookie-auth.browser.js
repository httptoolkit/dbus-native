module.exports = function doCookieAuth(_stream, _id, beginOrNextAuth) {
  // This effectively behaves the same as the 'default' / unknown auth method case in
  // client-handshake.js:
  console.error('DBUS_COOKIE_SHA1 authentication is not supported in browsers');
  beginOrNextAuth();
}