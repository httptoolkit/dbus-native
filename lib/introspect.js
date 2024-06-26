const FXP = require('fast-xml-parser');
const promisify = require('./promisify');

module.exports.introspectBus = function(obj, callback) {
  var bus = obj.service.bus;
  bus.invoke(
    {
      destination: obj.service.name,
      path: obj.name,
      interface: 'org.freedesktop.DBus.Introspectable',
      member: 'Introspect'
    },
    function(err, xml) {
      if (err) return callback(err);

      let result;
      try {
        result = module.exports.processXML(xml, obj);
      } catch (e) {
        return callback(e);
      }
      callback(null, result);
    }
  );
};

module.exports.processXML = function(xml, parentObj) {
  const parser = new FXP.XMLParser({
    // Match the processing style of xml2js:
    ignoreAttributes: false,
    attributesGroupName: '$',
    attributeNamePrefix: '',

    // Root should be an object, attributes are an object,
    // every sub node is an array:
    isArray: (name, path) => {
      return !(name === 'node' && path === 'node') &&
        name !== '$';
    }
  });

  let result = parser.parse(xml);
  if (!result.node) throw new Error('No root XML node');
  result = result.node; // unwrap the root node

  if (!result.interface) {
    throw new Error('No such interface found');
  }

  const interfaces = {};
  const nodes = [];
  const xmlInterfaces = result['interface'];
  const xmlNodes = result['node'] || [];

  for (let n = 1; n < xmlNodes.length; ++n) {
    // Start at 1 because we want to skip the root node
    nodes.push(xmlNodes[n]['$']['name']);
  }

  // For each defined interface
  for (let i = 0; i < xmlInterfaces.length; ++i) {
    const iface = xmlInterfaces[i];
    const ifaceName = iface['$'].name;
    const currentIface = interfaces[ifaceName] = new DBusInterface(parentObj, ifaceName);

    // Create methods for each method, with the signature for its args
    for (let m = 0; iface.method && m < iface.method.length; ++m) {
      const method = iface.method[m];
      const methodName = method['$'].name;
      let signature = '';

      for (let a = 0; method.arg && a < method.arg.length; ++a) {
        const arg = method.arg[a]['$'];
        if (arg.direction === 'in') signature += arg.type;
      }

      currentIface.$createMethod(methodName, signature);
    }

    // Create properties for each property
    for (let p = 0; iface.property && p < iface.property.length; ++p) {
      const property = iface.property[p];
      currentIface.$createProp(property['$'].name, property['$'].type, property['$'].access)
    }

    // TODO: introspect signals
  }

  return { interfaces, nodes };
}


function DBusInterface(parent_obj, ifname)
{
  // Since methods and props presently get added directly to the object, to avoid collision with existing names we must use $ naming convention as $ is invalid for dbus member names
  // https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names
  this.$parent = parent_obj; // parent DbusObject
  this.$name = ifname; // string interface name
  this.$methods = {}; // dictionary of methods (exposed for test), should we just store signature or use object to store more info?
  //this.$signals = {};
  this.$properties = {};
  this.$callbacks = [];
  this.$sigHandlers = [];
}
DBusInterface.prototype.$getSigHandler = function(callback) {
  var index;
  if ((index = this.$callbacks.indexOf(callback)) === -1) {
    index = this.$callbacks.push(callback) - 1;
    this.$sigHandlers[index] = function(messageBody) {
      callback.apply(null, messageBody);
    };
  }
  return this.$sigHandlers[index];
}
DBusInterface.prototype.addListener = DBusInterface.prototype.on = function(signame, callback) {
  // http://dbus.freedesktop.org/doc/api/html/group__DBusBus.html#ga4eb6401ba014da3dbe3dc4e2a8e5b3ef
  // An example is "type='signal',sender='org.freedesktop.DBus', interface='org.freedesktop.DBus',member='Foo', path='/bar/foo',destination=':452345.34'" ...
  var bus = this.$parent.service.bus;
  var signalFullName = bus.mangle(this.$parent.name, this.$name, signame);
  if (!bus.signals.listeners(signalFullName).length) {
    // This is the first time, so call addMatch
    var match = getMatchRule(this.$parent.name, this.$name, signame);
    bus.addMatch(match, function(err) {
      if (err) throw new Error(err);
      bus.signals.on(signalFullName, this.$getSigHandler(callback));
    }.bind(this));
  } else {
    // The match is already there, just add event listener
    bus.signals.on(signalFullName, this.$getSigHandler(callback));
  }
}
DBusInterface.prototype.removeListener = DBusInterface.prototype.off = function(signame, callback) {
  var bus = this.$parent.service.bus;
  var signalFullName = bus.mangle(this.$parent.name, this.$name, signame);
  bus.signals.removeListener( signalFullName, this.$getSigHandler(callback) );
  if (!bus.signals.listeners(signalFullName).length) {
    // There is no event handlers for this match
    var match = getMatchRule(this.$parent.name, this.$name, signame);
    bus.removeMatch(match, function(err) {
      if (err) throw new Error(err);
      // Now it is safe to empty these arrays
      this.$callbacks.length = 0;
      this.$sigHandlers.length = 0;
    }.bind(this));
  }
}
DBusInterface.prototype.$createMethod = function(mName, signature)
{
  this.$methods[mName] = signature;
  this[mName] = promisify(function() { return this.$callMethod(mName, arguments); });
}
DBusInterface.prototype.$callMethod = function(mName, args)
{
  var bus = this.$parent.service.bus;
  if (!Array.isArray(args)) args = Array.from(args); // Array.prototype.slice.apply(args)
  var callback =
    typeof args[args.length - 1] === 'function'
      ? args.pop()
      : () => {};

  var msg = {
    destination: this.$parent.service.name,
    path: this.$parent.name,
    interface: this.$name,
    member: mName
  };

  if (this.$methods[mName] !== '') {
    msg.signature = this.$methods[mName];
    msg.body = args;
  }

  bus.invoke(msg, callback);
}
DBusInterface.prototype.$createProp = function(propName, propType, propAccess)
{
  this.$properties[propName] = { type: propType, access: propAccess };
  Object.defineProperty(this, propName, {
    enumerable: true,
    get: () => callback => this.$readProp(propName, callback),
    set: function(val) { this.$writeProp(propName, val) }
  });
}
DBusInterface.prototype.$readProp = function(propName, callback)
{
  var bus = this.$parent.service.bus;
  bus.invoke(
    {
      destination: this.$parent.service.name,
      path: this.$parent.name,
      interface: 'org.freedesktop.DBus.Properties',
      member: 'Get',
      signature: 'ss',
      body: [this.$name, propName]
    },
    function(err, val) {
      if (err) {
        callback(err);
      } else {
        var signature = val[0];
        if (signature.length === 1) {
          callback(err, val[1][0]);
        } else {
          callback(err, val[1]);
        }
      }
    }
  );
}
DBusInterface.prototype.$writeProp = function(propName, val)
{
  var bus = this.$parent.service.bus;
  bus.invoke({
    destination: this.$parent.service.name,
    path: this.$parent.name,
    interface: 'org.freedesktop.DBus.Properties',
    member: 'Set',
    signature: 'ssv',
    body: [this.$name, propName, [this.$properties[propName].type, val]]
  });
}


function getMatchRule(objName, ifName, signame) {
  return `type='signal',path='${objName}',interface='${ifName}',member='${signame}'`;
}
