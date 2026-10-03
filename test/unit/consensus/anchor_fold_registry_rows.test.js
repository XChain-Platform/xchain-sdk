'use strict';

const assert = require('assert');

const gates = require('../../../src/consensus/gate_registry');

const ENV = 'XC_ANCHOR_FOLD_REGTEST_ACTIVATION';
const KEYS = [
    'anchor_fold_activation.ANCHOR_FOLD_ACTIVATION',
    'archive_section_verdict_activation.ARCHIVE_SECTION_VERDICT_STATE_HASH_ACTIVATION',
];
const present = KEYS.filter((key) => gates.has(key));

function withEnv(value, fn) {
    const saved = process.env[ENV];
    try {
        if (value === undefined) delete process.env[ENV];
        else process.env[ENV] = value;
        return fn();
    } finally {
        if (saved === undefined) delete process.env[ENV];
        else process.env[ENV] = saved;
    }
}

describe('anchor fold activation registry rows', function () {
    it('ships the shared row pair atomically', function () {
        assert.ok(present.length === 0 || present.length === 2);
    });

    it('pins both activation maps inert by default', function () {
        withEnv(undefined, () => {
            for (const key of KEYS) {
                assert.deepStrictEqual(gates.get(key), {
                    mainnet: 9999999999,
                    'BTC:testnet': 154971,
                    'LTC:testnet': 4905844,
                    'DOGE:testnet': 67961578,
                    testnet: 9999999999,
                    regtest: null,
                });
            }
        });
    });

    it('arms both regtest entries from the shared variable', function () {
        withEnv('armed', () => {
            for (const key of KEYS) assert.strictEqual(gates.get(key).regtest, 0);
        });
    });

    it('keeps both entries inactive below the sentinel', function () {
        withEnv(undefined, () => {
            for (const key of KEYS) {
                assert.strictEqual(gates.activeAt(key, 'mainnet', null, 99999999, null), false);
                assert.strictEqual(gates.activeAt(key, 'testnet', null, 99999999, null), false);
            }
        });
    });
});
