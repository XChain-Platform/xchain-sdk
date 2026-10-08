'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const gates = require('../../../src/consensus/gate_registry');
const { REGTEST_ARMING } = require('../../../src/consensus/gate_registry/shared_rows.js');

const ENTRY = path.join(__dirname, '..', '..', '..', 'src', 'consensus', 'gate_registry.js');
const SHARED_ROWS_DIR = path.join(__dirname, '..', '..', '..', 'src', 'consensus', 'gate_registry');
const SHARED_ROW_HASHES = {
    'shared_rows.js':   '1db6bd06818eca6fc27a57858ac820592e6dc9e366e87e75be28ea099f8780dc',
    'shared_rows_1.js': '6769da650408acc79b5db6fa0d93f835b077a37d8f7885e8aa81d61bcd8618de',
    'shared_rows_2.js': '8c9ddc10be60387322faa3facbda25b7f17ac1c5ecefaf6340e78bb96dd7e496',
    'shared_rows_3.js': '89127614a54b9a4007b8e63f18c4f8abb0873d8f8cb0d3f31a1115d67485c2b4',
    'shared_rows_4.js': 'dec84cd5f6e10b5bc631eb3a68ddcdfa5e37c5fb10cdf01ddd43cbb35980dc9b',
    'shared_rows_5.js': 'c6749ca7043a9a0c3057ed3a7b4dfd92362dee351a9a3d7611efff69bfd1b7ae',
};
const BUNDLE_ORDER = 'anchor_bundle_order_activation.ANCHOR_BUNDLE_ORDER_ACTIVATION';
const STAKE_ENV = 'XC_ANCHOR_STAKE_REGTEST_ACTIVATION';

// Run fn with one variable set (or unset) and restore it after.
function withEnv(name, value, fn) {
    const saved = process.env[name];
    try {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
        return fn();
    } finally {
        if (saved === undefined) delete process.env[name];
        else process.env[name] = saved;
    }
}

const registered = Object.entries(REGTEST_ARMING).filter(([key]) => gates.has(key));

describe('gate registry env view covers the regtest arming grammar', function () {
    it('keeps the canonical shared row files byte-identical', function () {
        for (const [file, expected] of Object.entries(SHARED_ROW_HASHES)) {
            const bytes = fs.readFileSync(path.join(SHARED_ROWS_DIR, file));
            const actual = crypto.createHash('sha256').update(bytes).digest('hex');
            assert.strictEqual(actual, expected, file + ' differs from the canonical whole-file twin');
        }
    });

    it('holds at least one armable row, so the sweep below checks something', function () {
        assert.ok(registered.length > 0, 'no REGTEST_ARMING row is registered in the SDK copy');
    });

    registered.forEach(([key, rule]) => {
        it('arms ' + key + ' from ' + rule.env, function () {
            withEnv(rule.env, '702', () => {
                const row = gates.get(key);
                for (const k of rule.keys)
                    assert.strictEqual(row[k], 702, key + '[' + k + '] did not arm from ' + rule.env);
            });
        });
    });

    it('names a getter for every variable the arming grammar reads', function () {
        const entry = fs.readFileSync(ENTRY, 'utf8');
        const names = [...new Set(Object.values(REGTEST_ARMING).map((rule) => rule.env))];
        const missing = names.filter((name) => !entry.includes('get ' + name + '()'));
        assert.deepStrictEqual(missing, [], 'registryEnv has no getter for ' + missing.join(', '));
    });

    it('enforces bundle order from the venue height on an armed regtest venue', function () {
        withEnv(STAKE_ENV, '702', () => {
            assert.strictEqual(gates.get(BUNDLE_ORDER).regtest, 702);
            assert.strictEqual(gates.activeAt(BUNDLE_ORDER, 'regtest', 'DOGE', 701, null), false);
            assert.strictEqual(gates.activeAt(BUNDLE_ORDER, 'regtest', 'DOGE', 702, null), true);
        });
        withEnv(STAKE_ENV, undefined, () => assert.strictEqual(gates.get(BUNDLE_ORDER).regtest, 0));
    });
});
