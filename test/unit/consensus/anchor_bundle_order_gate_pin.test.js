'use strict';

const assert = require('assert');

const gates = require('../../../src/consensus/gate_registry');
const { registry } = require('../../../src/consensus/gate_registry/core');

const KEY = 'anchor_bundle_order_activation.ANCHOR_BUNDLE_ORDER_ACTIVATION';

describe('anchor bundle order activation registry pin', function () {
    it('pins the height row and activation behavior', function () {
        assert.strictEqual(gates.has(KEY), true);
        assert.strictEqual(registry.unitOf(KEY), 'height');
        assert.deepStrictEqual(gates.get(KEY), {
            mainnet: 9999999999,
            testnet: 9999999999,
            regtest: 0,
        });

        assert.strictEqual(gates.activeAt(KEY, 'regtest', null, 0, null), true);
        assert.strictEqual(gates.activeAt(KEY, 'regtest', null, 70000000, null), true);
        assert.strictEqual(gates.activeAt(KEY, 'testnet', null, 70000000, null), false);
        assert.strictEqual(gates.activeAt(KEY, 'mainnet', null, 70000000, null), false);
    });
});
