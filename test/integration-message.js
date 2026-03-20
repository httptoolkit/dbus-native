const assert = require('assert');
const { PassThrough } = require('stream');
const Long = require('long');
const message = require('../lib/message');
const constants = require('../lib/constants');

// Round-trip helper: marshall then unmarshall, return the result
function roundTrip(msg, opts) {
  const buf = message.marshall(msg);
  return message.unmarshall(buf, opts);
}

// Verify a message survives a marshall/unmarshall round-trip unchanged
function assertRoundTrip(msg, opts) {
  const result = roundTrip(msg, opts);
  assert.deepStrictEqual(result, msg);
}

// The unmarshaller returns variants as [signatureTree, [values]] while the
// marshaller expects [signatureString, value]. This is a known API asymmetry.
// These helpers convert the unmarshalled format back to the marshal format
// so we can verify round-trip correctness for messages containing variants.

function treeToSignature(node) {
  switch (node.type) {
    case 'a':
      return 'a' + treeToSignature(node.child[0]);
    case '(':
      return '(' + node.child.map(treeToSignature).join('') + ')';
    case '{':
      return '{' + node.child.map(treeToSignature).join('') + '}';
    default:
      return node.type;
  }
}

// Convert unmarshalled variant [tree, [values]] to marshal format [sigString, value]
function normalizeVariant(v) {
  var sig = v[0].map(treeToSignature).join('');
  var val = v[1].length === 1 ? v[1][0] : v[1];
  return [sig, normalizeValue(val, sig)];
}

// Recursively normalize values that may contain variants
function normalizeValue(val, sig) {
  if (sig === 'v') return normalizeVariant(val);
  if (sig[0] === 'a' && sig[1] === '{' && Array.isArray(val)) {
    // Dict: a{kv} — each entry is [key, value], normalize the values
    var valueSig = extractDictValueSig(sig);
    return val.map(function(entry) {
      return [entry[0], normalizeValue(entry[1], valueSig)];
    });
  }
  if (sig[0] === 'a' && Array.isArray(val)) {
    var elemSig = sig.slice(1);
    return val.map(function(v) { return normalizeValue(v, elemSig); });
  }
  if (sig[0] === '(' && Array.isArray(val)) {
    var childSigs = parseStructSigs(sig);
    return val.map(function(v, i) { return normalizeValue(v, childSigs[i]); });
  }
  return val;
}

// Extract the value signature from a dict signature like a{sv} → v
function extractDictValueSig(sig) {
  // sig is like a{sv} or a{sa{sv}} — skip 'a{' and key type, rest up to matching '}'
  var keySig = sig[2]; // dict keys are always basic types (single char)
  return sig.slice(3, sig.length - 1);
}

// Parse struct member signatures from a struct signature like (siu) → ['s','i','u']
function parseStructSigs(sig) {
  var inner = sig.slice(1, sig.length - 1); // strip parens
  var sigs = [];
  var i = 0;
  while (i < inner.length) {
    var end = findTypeEnd(inner, i);
    sigs.push(inner.slice(i, end));
    i = end;
  }
  return sigs;
}

// Find the end index of a complete type starting at pos
function findTypeEnd(sig, pos) {
  var c = sig[pos];
  if (c === 'a') return findTypeEnd(sig, pos + 1);
  if (c === '(') return findMatchingClose(sig, pos, '(', ')') + 1;
  if (c === '{') return findMatchingClose(sig, pos, '{', '}') + 1;
  return pos + 1;
}

function findMatchingClose(sig, pos, open, close) {
  var depth = 1;
  for (var i = pos + 1; i < sig.length; i++) {
    if (sig[i] === open) depth++;
    if (sig[i] === close) depth--;
    if (depth === 0) return i;
  }
  return sig.length;
}

// Normalize an unmarshalled message body that may contain variants
function normalizeBody(body, sig) {
  var parsedSigs = [];
  var i = 0;
  while (i < sig.length) {
    var end = findTypeEnd(sig, i);
    parsedSigs.push(sig.slice(i, end));
    i = end;
  }
  return body.map(function(val, idx) {
    return normalizeValue(val, parsedSigs[idx]);
  });
}

// Round-trip for messages containing variants: marshall → unmarshall →
// normalize variant format → compare
function assertVariantRoundTrip(msg, opts) {
  const result = roundTrip(msg, opts);
  // Normalize the body to convert unmarshalled variant format back
  if (result.body && result.signature) {
    result.body = normalizeBody(result.body, result.signature);
  }
  assert.deepStrictEqual(result, msg);
}

describe('message round-trips', function() {

  describe('method calls', function() {

    it('with no body', function() {
      assertRoundTrip({
        type: constants.messageType.methodCall,
        flags: 0,
        serial: 1,
        path: '/org/freedesktop/DBus',
        interface: 'org.freedesktop.DBus',
        member: 'ListNames',
        destination: 'org.freedesktop.DBus'
      });
    });

    it('with string args (ss)', function() {
      assertRoundTrip({
        type: constants.messageType.methodCall,
        flags: 0,
        serial: 1,
        path: '/org/freedesktop/DBus',
        interface: 'org.freedesktop.DBus.Properties',
        member: 'Get',
        destination: 'org.freedesktop.DBus',
        signature: 'ss',
        body: ['org.freedesktop.DBus', 'Features']
      });
    });

    it('with unsigned integer args (uu)', function() {
      assertRoundTrip({
        type: constants.messageType.methodCall,
        flags: 0,
        serial: 42,
        path: '/com/example/Obj',
        member: 'DoStuff',
        destination: 'com.example.Service',
        signature: 'uu',
        body: [0, 0xffffffff]
      });
    });

    it('with mixed types (su)', function() {
      assertRoundTrip({
        type: constants.messageType.methodCall,
        flags: 0,
        serial: 3,
        path: '/com/example/Obj',
        member: 'RequestName',
        destination: 'org.freedesktop.DBus',
        interface: 'org.freedesktop.DBus',
        signature: 'su',
        body: ['com.example.MyService', 0]
      });
    });

    it('with boolean args', function() {
      assertRoundTrip({
        type: constants.messageType.methodCall,
        flags: 0,
        serial: 5,
        path: '/obj',
        member: 'SetEnabled',
        signature: 'bb',
        body: [true, false]
      });
    });

    it('with double args', function() {
      assertRoundTrip({
        type: constants.messageType.methodCall,
        flags: 0,
        serial: 6,
        path: '/obj',
        member: 'SetCoords',
        signature: 'dd',
        body: [3.141592653589793, -273.15]
      });
    });

    it('with signed integers including negatives', function() {
      assertRoundTrip({
        type: constants.messageType.methodCall,
        flags: 0,
        serial: 7,
        path: '/obj',
        member: 'Test',
        signature: 'nnii',
        body: [-1, -32768, 2147483647, -2147483648]
      });
    });

    it('with unsigned 16-bit integers', function() {
      assertRoundTrip({
        type: constants.messageType.methodCall,
        flags: 0,
        serial: 8,
        path: '/obj',
        member: 'Test',
        signature: 'qq',
        body: [0, 65535]
      });
    });

    it('with byte values', function() {
      assertRoundTrip({
        type: constants.messageType.methodCall,
        flags: 0,
        serial: 9,
        path: '/obj',
        member: 'Test',
        signature: 'yyy',
        body: [0, 127, 255]
      });
    });

    it('with 64-bit signed integers', function() {
      assertRoundTrip({
        type: constants.messageType.methodCall,
        flags: 0,
        serial: 10,
        path: '/obj',
        member: 'Test',
        signature: 'xx',
        body: [0, 9007199254740991] // max safe integer
      });
    });

    it('with 64-bit unsigned integers', function() {
      assertRoundTrip({
        type: constants.messageType.methodCall,
        flags: 0,
        serial: 11,
        path: '/obj',
        member: 'Test',
        signature: 'tt',
        body: [0, 9007199254740991]
      });
    });

    it('with 64-bit integers as Long.js objects', function() {
      const maxSigned = Long.fromString('9223372036854775807', false);
      const minSigned = Long.fromString('-9223372036854775808', false);
      const maxUnsigned = Long.fromString('18446744073709551615', true);

      assertRoundTrip({
        type: constants.messageType.methodCall,
        flags: 0,
        serial: 12,
        path: '/obj',
        member: 'Test',
        signature: 'xxt',
        body: [maxSigned, minSigned, maxUnsigned]
      }, { ReturnLongjs: true });
    });

    it('with byte array (ay)', function() {
      assertRoundTrip({
        type: constants.messageType.methodCall,
        flags: 0,
        serial: 13,
        path: '/obj',
        member: 'SendData',
        signature: 'ay',
        body: [Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd])]
      });
    });

    it('with empty byte array', function() {
      assertRoundTrip({
        type: constants.messageType.methodCall,
        flags: 0,
        serial: 14,
        path: '/obj',
        member: 'SendData',
        signature: 'ay',
        body: [Buffer.alloc(0)]
      });
    });

    it('with array of strings (as)', function() {
      assertRoundTrip({
        type: constants.messageType.methodCall,
        flags: 0,
        serial: 15,
        path: '/obj',
        member: 'Test',
        signature: 'as',
        body: [['hello', 'world', 'foo']]
      });
    });

    it('with empty array', function() {
      assertRoundTrip({
        type: constants.messageType.methodCall,
        flags: 0,
        serial: 16,
        path: '/obj',
        member: 'Test',
        signature: 'ai',
        body: [[]]
      });
    });

    it('with dict a{ss}', function() {
      assertRoundTrip({
        type: constants.messageType.methodCall,
        flags: 0,
        serial: 17,
        path: '/obj',
        member: 'SetEnv',
        signature: 'a{ss}',
        body: [[['HOME', '/home/user'], ['PATH', '/usr/bin']]]
      });
    });

    it('with dict a{sv} containing varied types', function() {
      assertVariantRoundTrip({
        type: constants.messageType.methodCall,
        flags: 0,
        serial: 18,
        path: '/obj',
        member: 'SetProperties',
        signature: 'a{sv}',
        body: [[
          ['Name', ['s', 'my-service']],
          ['Port', ['u', 8080]],
          ['Enabled', ['b', true]]
        ]]
      });
    });

    it('with struct body (si)', function() {
      assertRoundTrip({
        type: constants.messageType.methodCall,
        flags: 0,
        serial: 19,
        path: '/obj',
        member: 'Test',
        signature: '(si)',
        body: [['hello', 42]]
      });
    });

    it('with array of structs a(si)', function() {
      assertRoundTrip({
        type: constants.messageType.methodCall,
        flags: 0,
        serial: 20,
        path: '/obj',
        member: 'Test',
        signature: 'a(si)',
        body: [[['alice', 1], ['bob', 2], ['charlie', 3]]]
      });
    });

    it('with variant containing a string', function() {
      assertVariantRoundTrip({
        type: constants.messageType.methodCall,
        flags: 0,
        serial: 21,
        path: '/obj',
        member: 'Set',
        signature: 'v',
        body: [['s', 'hello']]
      });
    });

    it('with variant containing an array', function() {
      assertVariantRoundTrip({
        type: constants.messageType.methodCall,
        flags: 0,
        serial: 22,
        path: '/obj',
        member: 'Set',
        signature: 'v',
        body: [['ai', [1, 2, 3]]]
      });
    });

    it('with nested containers a(sa{sv})', function() {
      assertVariantRoundTrip({
        type: constants.messageType.methodCall,
        flags: 0,
        serial: 23,
        path: '/obj',
        member: 'Configure',
        signature: 'a(sa{sv})',
        body: [[
          ['section1', [['key1', ['s', 'val1']], ['key2', ['u', 100]]]],
          ['section2', [['enabled', ['b', false]]]]
        ]]
      });
    });

    it('with object path arg', function() {
      assertRoundTrip({
        type: constants.messageType.methodCall,
        flags: 0,
        serial: 24,
        path: '/org/freedesktop/DBus',
        member: 'GetConnectionUnixUser',
        signature: 'o',
        body: ['/org/freedesktop/NetworkManager/ActiveConnection/1']
      });
    });

    it('with signature type arg', function() {
      assertRoundTrip({
        type: constants.messageType.methodCall,
        flags: 0,
        serial: 25,
        path: '/obj',
        member: 'Test',
        signature: 'g',
        body: ['a{sv}']
      });
    });

    it('with empty string', function() {
      assertRoundTrip({
        type: constants.messageType.methodCall,
        flags: 0,
        serial: 26,
        path: '/obj',
        member: 'Test',
        signature: 's',
        body: ['']
      });
    });

    it('with UTF-8 string', function() {
      assertRoundTrip({
        type: constants.messageType.methodCall,
        flags: 0,
        serial: 27,
        path: '/obj',
        member: 'Test',
        signature: 's',
        body: ['\u00e9\u00e8\u00ea \u2603 \ud83d\ude00']
      });
    });

    it('with all header fields populated', function() {
      assertRoundTrip({
        type: constants.messageType.methodCall,
        flags: 0,
        serial: 100,
        path: '/org/example/Path',
        interface: 'org.example.Interface',
        member: 'Method',
        destination: 'org.example.Destination',
        sender: ':1.42',
        signature: 's',
        body: ['test']
      });
    });

    it('with NO_REPLY_EXPECTED flag', function() {
      assertRoundTrip({
        type: constants.messageType.methodCall,
        flags: constants.flags.noReplyExpected,
        serial: 28,
        path: '/obj',
        member: 'FireAndForget',
        signature: 's',
        body: ['data']
      });
    });

    it('with NO_AUTO_START flag', function() {
      assertRoundTrip({
        type: constants.messageType.methodCall,
        flags: constants.flags.noAutoStart,
        serial: 29,
        path: '/obj',
        member: 'Test',
        destination: 'org.example.Service',
        signature: 's',
        body: ['data']
      });
    });

    it('with large serial number', function() {
      assertRoundTrip({
        type: constants.messageType.methodCall,
        flags: 0,
        serial: 0xfffffffe,
        path: '/obj',
        member: 'Test'
      });
    });

    it('with many body arguments of different types', function() {
      assertRoundTrip({
        type: constants.messageType.methodCall,
        flags: 0,
        serial: 30,
        path: '/obj',
        member: 'BigMethod',
        signature: 'ybnqiudsx',
        body: [255, true, -1, 1000, -100000, 100000, 1.5, 'hello', 42]
      });
    });

    it('with deeply nested arrays', function() {
      assertRoundTrip({
        type: constants.messageType.methodCall,
        flags: 0,
        serial: 31,
        path: '/obj',
        member: 'Test',
        signature: 'aai',
        body: [[[1, 2], [3, 4], [5, 6]]]
      });
    });

    it('with dict of dict a{sa{su}}', function() {
      assertRoundTrip({
        type: constants.messageType.methodCall,
        flags: 0,
        serial: 32,
        path: '/obj',
        member: 'Test',
        signature: 'a{sa{su}}',
        body: [[
          ['group1', [['a', 1], ['b', 2]]],
          ['group2', [['c', 3]]]
        ]]
      });
    });

    it('with root object path /', function() {
      assertRoundTrip({
        type: constants.messageType.methodCall,
        flags: 0,
        serial: 33,
        path: '/',
        member: 'Introspect',
        interface: 'org.freedesktop.DBus.Introspectable'
      });
    });
  });

  describe('method returns', function() {

    it('with single string return', function() {
      assertRoundTrip({
        type: constants.messageType.methodReturn,
        flags: 0,
        serial: 2,
        replySerial: 1,
        destination: ':1.42',
        signature: 's',
        body: ['hello']
      });
    });

    it('with array of strings (as)', function() {
      assertRoundTrip({
        type: constants.messageType.methodReturn,
        flags: 0,
        serial: 2,
        replySerial: 1,
        destination: ':1.42',
        signature: 'as',
        body: [[':1.0', ':1.1', 'org.freedesktop.DBus', 'org.freedesktop.Notifications']]
      });
    });

    it('with no body', function() {
      assertRoundTrip({
        type: constants.messageType.methodReturn,
        flags: 0,
        serial: 2,
        replySerial: 1,
        destination: ':1.42'
      });
    });

    it('with a{sv} properties return', function() {
      assertVariantRoundTrip({
        type: constants.messageType.methodReturn,
        flags: 0,
        serial: 2,
        replySerial: 1,
        destination: ':1.42',
        signature: 'a{sv}',
        body: [[
          ['Version', ['s', '1.0']],
          ['MaxConnections', ['u', 256]],
          ['Active', ['b', true]]
        ]]
      });
    });

    it('with multiple return values', function() {
      assertRoundTrip({
        type: constants.messageType.methodReturn,
        flags: 0,
        serial: 2,
        replySerial: 1,
        destination: ':1.42',
        signature: 'si',
        body: ['result', 0]
      });
    });

    it('with variant return', function() {
      assertVariantRoundTrip({
        type: constants.messageType.methodReturn,
        flags: 0,
        serial: 2,
        replySerial: 1,
        destination: ':1.42',
        signature: 'v',
        body: [['as', ['one', 'two', 'three']]]
      });
    });
  });

  describe('error messages', function() {

    it('with string body', function() {
      assertRoundTrip({
        type: constants.messageType.error,
        flags: 0,
        serial: 3,
        replySerial: 1,
        destination: ':1.42',
        errorName: 'org.freedesktop.DBus.Error.ServiceUnknown',
        signature: 's',
        body: ['The name com.example.Missing was not provided by any .service files']
      });
    });

    it('with no body', function() {
      assertRoundTrip({
        type: constants.messageType.error,
        flags: 0,
        serial: 3,
        replySerial: 1,
        destination: ':1.42',
        errorName: 'org.freedesktop.DBus.Error.Failed'
      });
    });

    it('with multiple body args', function() {
      assertRoundTrip({
        type: constants.messageType.error,
        flags: 0,
        serial: 3,
        replySerial: 1,
        destination: ':1.42',
        errorName: 'org.freedesktop.DBus.Error.InvalidArgs',
        signature: 'ss',
        body: ['Invalid argument', 'Expected uint32']
      });
    });
  });

  describe('signals', function() {

    it('with string body', function() {
      assertRoundTrip({
        type: constants.messageType.signal,
        flags: 0,
        serial: 4,
        path: '/org/freedesktop/DBus',
        interface: 'org.freedesktop.DBus',
        member: 'NameOwnerChanged',
        signature: 'sss',
        body: ['com.example.Service', '', ':1.42']
      });
    });

    it('with no body', function() {
      assertRoundTrip({
        type: constants.messageType.signal,
        flags: 0,
        serial: 5,
        path: '/org/freedesktop/DBus',
        interface: 'org.freedesktop.DBus',
        member: 'NameAcquired'
      });
    });

    it('with complex body', function() {
      assertVariantRoundTrip({
        type: constants.messageType.signal,
        flags: 0,
        serial: 6,
        path: '/org/freedesktop/NetworkManager',
        interface: 'org.freedesktop.DBus.Properties',
        member: 'PropertiesChanged',
        signature: 'sa{sv}as',
        body: [
          'org.freedesktop.NetworkManager',
          [['State', ['u', 70]]],
          []
        ]
      });
    });

    it('PropertiesChanged with multiple changed properties', function() {
      assertVariantRoundTrip({
        type: constants.messageType.signal,
        flags: 0,
        serial: 7,
        path: '/org/freedesktop/NetworkManager/Devices/1',
        interface: 'org.freedesktop.DBus.Properties',
        member: 'PropertiesChanged',
        signature: 'sa{sv}as',
        body: [
          'org.freedesktop.NetworkManager.Device',
          [
            ['State', ['u', 100]],
            ['Ip4Address', ['u', 0xC0A80001]],
            ['Managed', ['b', true]]
          ],
          ['HwAddress', 'Speed']
        ]
      });
    });
  });

  describe('alignment stress', function() {
    // These test cases create various header sizes to exercise different
    // body alignment padding scenarios

    it('short path and member (minimal header)', function() {
      assertRoundTrip({
        type: constants.messageType.methodCall,
        flags: 0,
        serial: 1,
        path: '/',
        member: 'P',
        signature: 'u',
        body: [42]
      });
    });

    it('long path and member (large header)', function() {
      assertRoundTrip({
        type: constants.messageType.methodCall,
        flags: 0,
        serial: 1,
        path: '/org/freedesktop/NetworkManager/Settings/Connections/1',
        interface: 'org.freedesktop.NetworkManager.Settings.Connection',
        member: 'GetSettings',
        destination: 'org.freedesktop.NetworkManager',
        signature: 'u',
        body: [42]
      });
    });

    it('body with 8-byte aligned types after varied header sizes', function() {
      // Doubles and int64s require 8-byte alignment in the body
      assertRoundTrip({
        type: constants.messageType.methodCall,
        flags: 0,
        serial: 1,
        path: '/a',
        member: 'M',
        signature: 'dx',
        body: [1.0, 1]
      });
    });

    it('multiple types requiring different alignments', function() {
      assertRoundTrip({
        type: constants.messageType.methodCall,
        flags: 0,
        serial: 1,
        path: '/obj',
        member: 'Test',
        signature: 'ynqiudxt',
        body: [1, -2, 3, -4, 5, 6.0, 7, 8]
      });
    });

    it('struct alignment within array', function() {
      // Structs must be 8-byte aligned; test this with varying element sizes
      assertRoundTrip({
        type: constants.messageType.methodCall,
        flags: 0,
        serial: 1,
        path: '/obj',
        member: 'Test',
        signature: 'a(ys)',
        body: [[
          [1, 'a'],
          [2, 'bb'],
          [3, 'ccc']
        ]]
      });
    });

    it('dict entry alignment', function() {
      // Dict entries align like structs (8 bytes)
      assertRoundTrip({
        type: constants.messageType.methodCall,
        flags: 0,
        serial: 1,
        path: '/obj',
        member: 'Test',
        signature: 'a{yi}',
        body: [[
          [1, 100],
          [2, 200],
          [3, 300]
        ]]
      });
    });
  });
});

describe('binary format verification', function() {

  it('uses little-endian byte order marker (0x6C)', function() {
    const buf = message.marshall({
      type: constants.messageType.methodCall,
      serial: 1,
      path: '/',
      member: 'Test'
    });
    assert.strictEqual(buf[0], 0x6C);
  });

  it('sets correct message type byte', function() {
    [
      [constants.messageType.methodCall, 1],
      [constants.messageType.methodReturn, 2],
      [constants.messageType.error, 3],
      [constants.messageType.signal, 4]
    ].forEach(function([type, expected]) {
      const buf = message.marshall({
        type: type,
        serial: 1,
        path: '/',
        member: 'Test',
        // error and method_return need replySerial
        replySerial: type >= 2 ? 1 : undefined,
        errorName: type === 3 ? 'org.example.Error' : undefined
      });
      assert.strictEqual(buf[1], expected, `type ${type} should be byte ${expected}`);
    });
  });

  it('sets protocol version to 1', function() {
    const buf = message.marshall({
      type: constants.messageType.methodCall,
      serial: 1,
      path: '/',
      member: 'Test'
    });
    assert.strictEqual(buf[3], 1);
  });

  it('sets correct flags byte', function() {
    const buf = message.marshall({
      type: constants.messageType.methodCall,
      serial: 1,
      flags: 0x03, // NO_REPLY_EXPECTED | NO_AUTO_START
      path: '/',
      member: 'Test'
    });
    assert.strictEqual(buf[2], 0x03);
  });

  it('encodes serial correctly in bytes 8-11 (LE uint32)', function() {
    const buf = message.marshall({
      type: constants.messageType.methodCall,
      serial: 0x01020304,
      path: '/',
      member: 'Test'
    });
    assert.strictEqual(buf.readUInt32LE(8), 0x01020304);
  });

  it('body length in bytes 4-7 matches actual body length', function() {
    const buf = message.marshall({
      type: constants.messageType.methodCall,
      serial: 1,
      path: '/',
      member: 'Test',
      signature: 'ss',
      body: ['hello', 'world']
    });
    const bodyLength = buf.readUInt32LE(4);
    // Body starts after the header, which is padded to 8-byte boundary
    // The header fields array length is at byte 12
    const fieldsLength = buf.readUInt32LE(12);
    const fieldsPadded = (fieldsLength + 7) & ~7;
    const headerEnd = 16 + fieldsPadded; // 12 fixed + 4 array length + fields + padding
    assert.strictEqual(bodyLength, buf.length - headerEnd,
      'body length field should match actual remaining bytes');
  });

  it('body starts at 8-byte aligned offset', function() {
    // Test with several different header sizes
    var msgs = [
      { type: 1, serial: 1, path: '/', member: 'T', signature: 'u', body: [1] },
      { type: 1, serial: 1, path: '/a/b/c/d', member: 'Method', destination: 'org.example.Svc', signature: 'u', body: [1] },
      { type: 1, serial: 1, path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'Hello', signature: 'u', body: [1] }
    ];
    msgs.forEach(function(msg) {
      const buf = message.marshall(msg);
      const bodyLength = buf.readUInt32LE(4);
      if (bodyLength > 0) {
        const bodyStart = buf.length - bodyLength;
        assert.strictEqual(bodyStart % 8, 0,
          `body should start at 8-byte aligned offset, got ${bodyStart}`);
      }
    });
  });

  it('boolean true is serialized as uint32 value 1', function() {
    const buf = message.marshall({
      type: constants.messageType.methodCall,
      serial: 1,
      path: '/',
      member: 'Test',
      signature: 'b',
      body: [true]
    });
    const bodyLength = buf.readUInt32LE(4);
    const bodyStart = buf.length - bodyLength;
    // Boolean is a 4-byte uint32 aligned to 4 bytes
    assert.strictEqual(bodyLength, 4, 'boolean body should be 4 bytes');
    assert.strictEqual(buf.readUInt32LE(bodyStart), 1, 'true should be uint32 value 1');
  });

  it('boolean false is serialized as uint32 value 0', function() {
    const buf = message.marshall({
      type: constants.messageType.methodCall,
      serial: 1,
      path: '/',
      member: 'Test',
      signature: 'b',
      body: [false]
    });
    const bodyLength = buf.readUInt32LE(4);
    const bodyStart = buf.length - bodyLength;
    assert.strictEqual(bodyLength, 4, 'boolean body should be 4 bytes');
    assert.strictEqual(buf.readUInt32LE(bodyStart), 0, 'false should be uint32 value 0');
  });

  it('string is encoded as uint32 length + UTF-8 + null terminator', function() {
    const buf = message.marshall({
      type: constants.messageType.methodCall,
      serial: 1,
      path: '/',
      member: 'Test',
      signature: 's',
      body: ['hello']
    });
    const bodyLength = buf.readUInt32LE(4);
    const bodyStart = buf.length - bodyLength;
    // String: 4 bytes length + 5 bytes "hello" + 1 byte null = 10
    assert.strictEqual(buf.readUInt32LE(bodyStart), 5, 'string length should be 5');
    assert.strictEqual(
      buf.toString('utf8', bodyStart + 4, bodyStart + 9),
      'hello'
    );
    assert.strictEqual(buf[bodyStart + 9], 0, 'string should be null-terminated');
  });

  it('empty string is encoded as zero length + null terminator', function() {
    const buf = message.marshall({
      type: constants.messageType.methodCall,
      serial: 1,
      path: '/',
      member: 'Test',
      signature: 's',
      body: ['']
    });
    const bodyLength = buf.readUInt32LE(4);
    const bodyStart = buf.length - bodyLength;
    assert.strictEqual(buf.readUInt32LE(bodyStart), 0, 'empty string length should be 0');
    assert.strictEqual(buf[bodyStart + 4], 0, 'empty string should have null terminator');
  });

  it('signature type is encoded as byte length + content + null (no uint32 length prefix)', function() {
    const buf = message.marshall({
      type: constants.messageType.methodCall,
      serial: 1,
      path: '/',
      member: 'Test',
      signature: 'g',
      body: ['ss']
    });
    const bodyLength = buf.readUInt32LE(4);
    const bodyStart = buf.length - bodyLength;
    // Signature: 1 byte length + content + null terminator
    assert.strictEqual(buf[bodyStart], 2, 'signature length byte should be 2');
    assert.strictEqual(buf[bodyStart + 1], 0x73, 'first char should be s');
    assert.strictEqual(buf[bodyStart + 2], 0x73, 'second char should be s');
    assert.strictEqual(buf[bodyStart + 3], 0, 'signature should be null-terminated');
  });

  it('array is encoded as uint32 byte-count of elements', function() {
    const buf = message.marshall({
      type: constants.messageType.methodCall,
      serial: 1,
      path: '/',
      member: 'Test',
      signature: 'ai',
      body: [[1, 2, 3]]
    });
    const bodyLength = buf.readUInt32LE(4);
    const bodyStart = buf.length - bodyLength;
    // Array: 4 bytes length + 3 * 4 bytes (three int32s) = 16
    assert.strictEqual(buf.readUInt32LE(bodyStart), 12,
      'array length should be byte count of elements (3 * 4 = 12)');
  });

  it('int32 is encoded as 4-byte signed little-endian', function() {
    const buf = message.marshall({
      type: constants.messageType.methodCall,
      serial: 1,
      path: '/',
      member: 'Test',
      signature: 'i',
      body: [-1]
    });
    const bodyLength = buf.readUInt32LE(4);
    const bodyStart = buf.length - bodyLength;
    assert.strictEqual(buf.readInt32LE(bodyStart), -1);
    // -1 in two's complement LE is FF FF FF FF
    assert.strictEqual(buf[bodyStart], 0xFF);
    assert.strictEqual(buf[bodyStart + 1], 0xFF);
    assert.strictEqual(buf[bodyStart + 2], 0xFF);
    assert.strictEqual(buf[bodyStart + 3], 0xFF);
  });

  it('double is encoded as 8-byte IEEE 754 little-endian', function() {
    const buf = message.marshall({
      type: constants.messageType.methodCall,
      serial: 1,
      path: '/',
      member: 'Test',
      signature: 'd',
      body: [1.5]
    });
    const bodyLength = buf.readUInt32LE(4);
    const bodyStart = buf.length - bodyLength;
    assert.strictEqual(buf.readDoubleLE(bodyStart), 1.5);
  });

  it('verifies a known simple message byte-for-byte', function() {
    // Construct the expected bytes for a method_call:
    // path="/", member="Ping", no body
    const buf = message.marshall({
      type: constants.messageType.methodCall,
      flags: 0,
      serial: 1,
      path: '/',
      member: 'Ping'
    });

    // Fixed header (12 bytes)
    assert.strictEqual(buf[0], 0x6C, 'endianness = little-endian');
    assert.strictEqual(buf[1], 0x01, 'type = method_call');
    assert.strictEqual(buf[2], 0x00, 'flags = 0');
    assert.strictEqual(buf[3], 0x01, 'protocol = 1');
    assert.strictEqual(buf.readUInt32LE(4), 0, 'body length = 0');
    assert.strictEqual(buf.readUInt32LE(8), 1, 'serial = 1');

    // Total length should be 8-byte aligned
    assert.strictEqual(buf.length % 8, 0, 'message length should be 8-byte aligned');

    // Unmarshall and verify round-trip
    const msg = message.unmarshall(buf);
    assert.strictEqual(msg.type, 1);
    assert.strictEqual(msg.serial, 1);
    assert.strictEqual(msg.path, '/');
    assert.strictEqual(msg.member, 'Ping');
  });
});

describe('streaming message parsing', function() {

  it('can parse multiple messages written to a stream', function(done) {
    const stream = new PassThrough();
    const received = [];

    const msg1 = {
      type: constants.messageType.methodCall,
      serial: 1,
      path: '/obj',
      member: 'Method1',
      signature: 's',
      body: ['first']
    };
    const msg2 = {
      type: constants.messageType.methodCall,
      serial: 2,
      path: '/obj',
      member: 'Method2',
      signature: 'u',
      body: [42]
    };
    const msg3 = {
      type: constants.messageType.signal,
      serial: 3,
      path: '/org/example',
      interface: 'org.example.Iface',
      member: 'SomethingHappened',
      signature: 's',
      body: ['event-data']
    };

    message.unmarshalMessages(stream, function(msg) {
      received.push(msg);
      if (received.length === 3) {
        assert.strictEqual(received[0].member, 'Method1');
        assert.deepStrictEqual(received[0].body, ['first']);
        assert.strictEqual(received[1].member, 'Method2');
        assert.deepStrictEqual(received[1].body, [42]);
        assert.strictEqual(received[2].member, 'SomethingHappened');
        assert.deepStrictEqual(received[2].body, ['event-data']);
        done();
      }
    });

    stream.write(message.marshall(msg1));
    stream.write(message.marshall(msg2));
    stream.write(message.marshall(msg3));
  });

  it('can parse messages written as a single concatenated buffer', function(done) {
    const stream = new PassThrough();
    const received = [];

    const msg1 = {
      type: constants.messageType.methodCall,
      serial: 1,
      path: '/obj',
      member: 'M1',
      signature: 'u',
      body: [1]
    };
    const msg2 = {
      type: constants.messageType.methodCall,
      serial: 2,
      path: '/obj',
      member: 'M2',
      signature: 'u',
      body: [2]
    };

    message.unmarshalMessages(stream, function(msg) {
      received.push(msg);
      if (received.length === 2) {
        assert.strictEqual(received[0].serial, 1);
        assert.strictEqual(received[1].serial, 2);
        done();
      }
    });

    const combined = Buffer.concat([
      message.marshall(msg1),
      message.marshall(msg2)
    ]);
    stream.write(combined);
  });

  it('can parse a message arriving in small chunks', function(done) {
    const stream = new PassThrough();

    const msg = {
      type: constants.messageType.methodCall,
      serial: 1,
      path: '/org/example/Object',
      member: 'TestMethod',
      signature: 'si',
      body: ['hello world', 42]
    };

    message.unmarshalMessages(stream, function(result) {
      assert.strictEqual(result.member, 'TestMethod');
      assert.deepStrictEqual(result.body, ['hello world', 42]);
      done();
    });

    const buf = message.marshall(msg);
    // Write one byte at a time
    let offset = 0;
    function writeNext() {
      if (offset < buf.length) {
        stream.write(buf.slice(offset, offset + 1));
        offset++;
        setImmediate(writeNext);
      }
    }
    writeNext();
  });

  it('can parse a message split between header and body', function(done) {
    const stream = new PassThrough();

    const msg = {
      type: constants.messageType.methodCall,
      serial: 1,
      path: '/obj',
      member: 'Test',
      signature: 'ss',
      body: ['hello', 'world']
    };

    message.unmarshalMessages(stream, function(result) {
      assert.deepStrictEqual(result.body, ['hello', 'world']);
      done();
    });

    const buf = message.marshall(msg);
    // Split at the 16-byte header boundary
    stream.write(buf.slice(0, 16));
    setTimeout(function() {
      stream.write(buf.slice(16));
    }, 10);
  });

  it('preserves message types through streaming', function(done) {
    const stream = new PassThrough();
    const received = [];

    const msgs = [
      {
        type: constants.messageType.methodCall,
        serial: 1,
        path: '/obj',
        member: 'Call',
        signature: 's',
        body: ['request']
      },
      {
        type: constants.messageType.methodReturn,
        serial: 2,
        replySerial: 1,
        destination: ':1.1',
        signature: 's',
        body: ['response']
      },
      {
        type: constants.messageType.error,
        serial: 3,
        replySerial: 1,
        destination: ':1.1',
        errorName: 'org.example.Error',
        signature: 's',
        body: ['something went wrong']
      },
      {
        type: constants.messageType.signal,
        serial: 4,
        path: '/obj',
        interface: 'org.example.Iface',
        member: 'Changed'
      }
    ];

    message.unmarshalMessages(stream, function(msg) {
      received.push(msg);
      if (received.length === 4) {
        assert.strictEqual(received[0].type, constants.messageType.methodCall);
        assert.strictEqual(received[1].type, constants.messageType.methodReturn);
        assert.strictEqual(received[1].replySerial, 1);
        assert.strictEqual(received[2].type, constants.messageType.error);
        assert.strictEqual(received[2].errorName, 'org.example.Error');
        assert.strictEqual(received[3].type, constants.messageType.signal);
        done();
      }
    });

    msgs.forEach(function(msg) {
      stream.write(message.marshall(msg));
    });
  });
});
