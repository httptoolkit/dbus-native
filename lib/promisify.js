module.exports = function promisify(fn) {
    return function () {
        let callback = arguments[arguments.length - 1];
        if (typeof callback !== 'function') {
            return new Promise((resolve, reject) => {
                fn.apply(this, [...arguments, (err, result) => {
                    if (err) reject(err);
                    else resolve(result);
                }]);
            })
        } else {
            fn.apply(this, arguments);
        }
    }
}