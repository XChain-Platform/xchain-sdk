//  doctrine test-coverage program: unit coverage for src/repl.js. The
// developer REPL entry point must load without opening an interactive session
// as a side effect (importing it is safe; only startREPL() drops into repl).
// Pins the exported contract.

const assert = require('assert');
const mod = require('../../src/repl.js');

describe('repl', function () {
    it('exports startREPL as a function', function () {
        assert.strictEqual(typeof mod.startREPL, 'function');
    });

    it('requiring the module opens no REPL (no throwing top-level side effect)', function () {
        delete require.cache[require.resolve('../../src/repl.js')];
        assert.doesNotThrow(() => require('../../src/repl.js'));
    });
});
