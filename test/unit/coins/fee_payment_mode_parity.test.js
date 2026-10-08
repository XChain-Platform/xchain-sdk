'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert');
const path = require('path');

const sdkCoins = require('../../../src/coins');
const feeMethods = require('../../../src/XChainSDK/fees_and_services.js');
const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout.js');

const INDEXER_ROOT = process.env.XCHAIN_INDEXER_PATH || process.env.XCHAIN_INDEXER_DIR
    || path.join(__dirname, '../../../..', 'xchain-indexer');
const INDEXER_COINS = path.resolve(INDEXER_ROOT, 'src', 'coins', 'index.js');

describe('SDK/indexer fee payment mode parity', function () {
    let indexerCoins;

    before(function () {
        const verdict = siblingCheckout(__dirname, INDEXER_COINS);
        if (!skipOrFail(this, verdict, 'the native fee-mode registry parity guard')) return;
        indexerCoins = require(verdict.path);
    });

    it('covers the same registered coins', function () {
        assert.deepStrictEqual(sdkCoins.ALLOWED_COINS, indexerCoins.ALLOWED_COINS);
    });

    it('requires native fees exactly where the indexer registry declares them', function () {
        for (const tick of indexerCoins.ALLOWED_COINS) {
            for (const [prefix, network] of [['', 'mainnet'], ['T', 'testnet'], ['R', 'regtest']]) {
                const sdkMode = sdkCoins.getCoinConfig(tick, network).FEE_PAYMENT_MODE;
                const indexerMode = indexerCoins.getCoinConfig(tick, network).FEE_PAYMENT_MODE;
                assert.strictEqual(sdkMode, indexerMode,
                    `${tick}/${network}: SDK and indexer FEE_PAYMENT_MODE differ`);
                assert.strictEqual(
                    feeMethods.nativeFeeRequired.call({ explorer: { coin: prefix + tick } }),
                    indexerMode === 'native',
                    `${prefix + tick}: SDK fee requirement differs from the indexer registry`
                );
            }
        }
    });
});
