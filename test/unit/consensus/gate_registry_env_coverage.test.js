'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const gates = require('../../../src/consensus/gate_registry');
const { REGTEST_ARMING } = require('../../../src/consensus/gate_registry/shared_rows.js');
const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout.js');

const ENTRY = path.join(__dirname, '..', '..', '..', 'src', 'consensus', 'gate_registry.js');
const SHARED_ROWS_DIR = path.join(__dirname, '..', '..', '..', 'src', 'consensus', 'gate_registry');
const SHARED_ROW_FILES = [
    'shared_rows.js',
    'shared_rows_1.js',
    'shared_rows_2.js',
    'shared_rows_3.js',
    'shared_rows_4.js',
    'shared_rows_5.js',
];
const SIBLING_ROOT = process.env.XCHAIN_SIBLING_ROOT
    || path.join(__dirname, '..', '..', '..', '..');
const INDEXER_ROOT = process.env.XCHAIN_INDEXER_PATH || process.env.XCHAIN_INDEXER_DIR
    || path.join(SIBLING_ROOT, 'xchain-indexer');
const INDEXER_SHARED_ROWS_DIR = path.join(INDEXER_ROOT, 'src', 'protocol_changes');
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
        const verdict = siblingCheckout(__dirname, INDEXER_SHARED_ROWS_DIR);
        if (!skipOrFail(this, verdict, 'the canonical indexer shared-row byte-identity guard')) return;
        for (const file of SHARED_ROW_FILES) {
            const local = fs.readFileSync(path.join(SHARED_ROWS_DIR, file));
            const canonical = fs.readFileSync(path.join(verdict.path, file));
            assert.ok(local.equals(canonical), file + ' differs from the indexer canonical whole-file twin');
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
