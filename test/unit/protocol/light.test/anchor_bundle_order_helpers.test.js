/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const {
    sectionsChainOrderReason,
    sigsPubkeyOrderReason
} = require('../../../../src/protocol/light_client/anchored_checkpoint.js');
const {
    bundleOrderEnforced,
    bundleOrderRefusal
} = require('../../../../src/protocol/light_client/anchor_bundle_order.js');

const reasons = { sectionsChainOrderReason, sigsPubkeyOrderReason };

function section(chain, pubkeys) {
    return {
        chain,
        validator_signatures: pubkeys.map(pubkey => ({ pubkey, sig: 'signature' }))
    };
}

describe('ANCHOR bundle order enforcement helper', function () {
    it('is active on regtest at height zero and later', function () {
        assert.strictEqual(bundleOrderEnforced('regtest', 0), true);
        assert.strictEqual(bundleOrderEnforced('regtest', 70000000), true);
    });

    it('is inactive on unarmed networks and armed on testnet from the v0.21.3 DOGE height', function () {
        assert.strictEqual(bundleOrderEnforced('testnet', 70000000), true);
        assert.strictEqual(bundleOrderEnforced('mainnet', 70000000), false);
    });

    it('is inactive without a finite numeric height', function () {
        for (const height of [undefined, null, NaN, '70000000'])
            assert.strictEqual(bundleOrderEnforced('regtest', height), false);
    });
});

describe('ANCHOR bundle order refusal helper', function () {
    it('accepts sorted sections and signature pairs', function () {
        const sections = [section('BTC', ['aa', 'bb']), section('DOGE', ['cc', 'dd'])];
        assert.strictEqual(bundleOrderRefusal(sections, reasons), null);
    });

    it('accepts tied sections and signature pairs', function () {
        const sections = [section('BTC', ['aa', 'aa']), section('BTC', ['bb', 'bb'])];
        assert.strictEqual(bundleOrderRefusal(sections, reasons), null);
    });

    it('reports descending section order exactly', function () {
        const sections = [section('DOGE', ['aa']), section('BTC', ['bb'])];
        assert.strictEqual(
            bundleOrderRefusal(sections, reasons),
            'LightClient: ANCHOR sections not CHAIN-ascending'
        );
    });

    it('reports the zero-based index of the first section with descending pairs', function () {
        const sections = [section('BTC', ['aa', 'bb']), section('DOGE', ['dd', 'cc'])];
        assert.strictEqual(
            bundleOrderRefusal(sections, reasons),
            'LightClient: ANCHOR section 1 signatures not PUBKEY-ascending'
        );
    });

    it('reports section order before signature-pair order', function () {
        const sections = [section('DOGE', ['bb', 'aa']), section('BTC', ['dd', 'cc'])];
        assert.strictEqual(
            bundleOrderRefusal(sections, reasons),
            'LightClient: ANCHOR sections not CHAIN-ascending'
        );
    });
});
