'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert');
const sinon = require('sinon');

const coins = require('../../../src/coins');
const feeMethods = require('../../../src/XChainSDK/fees_and_services.js');

const VALID_MODES = ['native', 'xchain'];
const ROUTE_PREFIXES = [
    { prefix: '', network: 'mainnet' },
    { prefix: 'T', network: 'testnet' },
    { prefix: 'R', network: 'regtest' },
];

function required(routeCoin, opts = {}) {
    return feeMethods.nativeFeeRequired.call({ explorer: { coin: routeCoin } }, opts);
}

describe('SDK native-fee classification tracks the coin registry', function () {

    afterEach(function () {
        sinon.restore();
    });

    it('every registered coin declares a supported fee payment mode', function () {
        assert.ok(coins.ALLOWED_COINS.length > 0, 'ALLOWED_COINS is empty');
        for (const tick of coins.ALLOWED_COINS) {
            for (const { network } of ROUTE_PREFIXES) {
                const mode = coins.getCoinConfig(tick, network).FEE_PAYMENT_MODE;
                assert.ok(VALID_MODES.includes(mode),
                    `${tick}/${network}: unsupported FEE_PAYMENT_MODE ${JSON.stringify(mode)}`);
            }
        }
    });

    it('uses FEE_PAYMENT_MODE for every explorer route coin', function () {
        for (const tick of coins.ALLOWED_COINS) {
            for (const { prefix, network } of ROUTE_PREFIXES) {
                const routeCoin = prefix + tick;
                const expected = coins.getCoinConfig(tick, network).FEE_PAYMENT_MODE === 'native';
                assert.strictEqual(required(routeCoin), expected,
                    `${routeCoin} did not follow ${tick}/${network} FEE_PAYMENT_MODE`);
            }
        }
    });

    it('reads the registry field instead of inferring the mode from the ticker', function () {
        const stub = sinon.stub(coins, 'getCoinConfig');
        stub.withArgs('BTC', 'mainnet').returns({ FEE_PAYMENT_MODE: 'native' });
        assert.strictEqual(required('BTC'), true);
        stub.withArgs('BTC', 'mainnet').returns({ FEE_PAYMENT_MODE: 'xchain' });
        assert.strictEqual(required('BTC'), false);
    });

    it('keeps explicit caller choice authoritative and unknown routes non-native', function () {
        assert.strictEqual(required('BTC', { payFeeInNativeCoin: true }), true);
        assert.strictEqual(required('RDOGE', { payFeeInNativeCoin: false }), false);
        assert.strictEqual(required('UNKNOWN'), false);
        assert.strictEqual(feeMethods.nativeFeeRequired.call({}, {}), false);
    });
});
