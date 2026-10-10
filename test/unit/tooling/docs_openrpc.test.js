// Unit coverage for the docs component (docs/openrpc.build.js ->
// docs/openrpc.json), the published contract for the SDK's JSON-RPC surface.
// Pins the generated artifact's shape without invoking the side-effecting
// build script.

const assert = require('assert');
const doc = require('../../../docs/openrpc.json');

describe('docs/openrpc.json', function () {
    it('declares an OpenRPC version and info block', function () {
        assert.strictEqual(typeof doc.openrpc, 'string');
        assert.ok(/^\d+\.\d+\.\d+$/.test(doc.openrpc));
        assert.ok(doc.info && typeof doc.info.title === 'string' && doc.info.title.length > 0);
    });

    it('exposes a non-empty, well-formed methods array with unique names', function () {
        assert.ok(Array.isArray(doc.methods) && doc.methods.length > 0);
        for (const m of doc.methods) {
            assert.strictEqual(typeof m.name, 'string');
            assert.ok(m.name.length > 0);
            assert.ok(Array.isArray(m.params), `${m.name} must declare params[]`);
        }
        const names = doc.methods.map((m) => m.name);
        assert.strictEqual(new Set(names).size, names.length, 'method names must be unique');
    });

    it('documents the filtered get_markets tick orientation', function () {
        const method = doc.methods.find((candidate) => candidate.name === 'get_markets');
        assert.ok(method, 'get_markets must be documented');
        assert.strictEqual(
            method.description,
            'When params.tick is supplied, every returned pair puts the searched tick in tick2 and its values in tick2_* fields; the counter tick is in tick1. Read the searched tick\'s price from tick2_price.'
        );
    });
});
