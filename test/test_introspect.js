const introspect = require('../lib/introspect');
const fs = require('fs');
const path = require('path');

// Introspection test cases
var testCases = [{ desc: 'Basic Example', file: 'example' }];

describe('given introspect xml', function() {
  for (var i = 0; i < testCases.length; ++i) {
    var curTest = testCases[i];
    it('should correctly process ' + curTest.desc, function() {
      return testXml(curTest.file);
    });
  }
});

const dummyObj = {};
function testXml(fname) {
  var fpath = path.join(__dirname, 'fixtures', 'introspection', fname);
  return new Promise((resolve, reject) => {
    // get expected data from json file
    fs.readFile(fpath + '.json', 'utf8', function(err, data) {
      if (err) reject(err);
      var test_obj = JSON.parse(data);
      // get introspect xml from xml file
      fs.readFile(fpath + '.xml', function(err, xml_data) {
        if (err) reject(err);
        else {
          const result = introspect.processXML(xml_data, dummyObj);
          const { interfaces, nodes } = result;
          checkIntrospection(test_obj, interfaces, nodes);
          resolve();
        }
      });
    });
  });
}

function checkIntrospection(test_obj, parsedInterfaces, _nodes) {
  for (let i = 0; i < test_obj.interfaces.length; ++i) {
    const testInterface = test_obj.interfaces[i];
    if (parsedInterfaces[testInterface.name] === undefined)
      throw new Error(
        'Failed to introspect interface name ' + testInterface.name
      );
    for (var m = 0; m < testInterface.methods.length; ++m) {
      const methodName = testInterface.methods[m].name;
      const curMethod = parsedInterfaces[testInterface.name].$methods[methodName];
      if (curMethod === undefined)
        throw new Error(
          'Failed to introspect method name ' +
            methodName +
            ' of ' +
            testInterface.name
        );
      if (curMethod !== testInterface.methods[m].signature)
        throw new Error(
          'Failed to introspect method args of ' +
            methodName +
            ' of ' +
            testInterface.name
        );
    }
    for (let p = 0; p < testInterface.properties.length; ++p) {
      const propName = testInterface.properties[p].name;
      const curProp = parsedInterfaces[testInterface.name].$properties[propName];
      if (curProp === undefined)
        throw new Error(
          'Failed to introspect property name ' +
            propName +
            ' of ' +
            testInterface.name
        );
      if (curProp.type !== testInterface.properties[p].type)
        throw new Error(
          'Failed to introspect property type of ' +
            propName +
            ' of ' +
            testInterface.name
        );
    }
  }
}
