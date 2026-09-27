/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const {
    sectionsChainOrderReason,
    sigsPubkeyOrderReason
} = require('../../../src/protocol/light_client/anchored_checkpoint.js');

describe('ANCHOR v0 order reason helpers', function () {
    it('accepts CHAIN-ascending, empty, and one-section bundles', function () {
        assert.strictEqual(sectionsChainOrderReason([
            { chain: 'BTC' },
            { chain: 'DOGE' }
        ]), null);
        assert.strictEqual(sectionsChainOrderReason([]), null);
        assert.strictEqual(sectionsChainOrderReason([{ chain: 'BTC' }]), null);
    });

    it('reports the first descending CHAIN pair', function () {
        assert.strictEqual(sectionsChainOrderReason([
            { chain: 'DOGE' },
            { chain: 'BTC' }
        ]), 'ANCHOR sections not CHAIN-ascending');
    });

    it('accepts PUBKEY-ascending section signatures', function () {
        assert.strictEqual(sigsPubkeyOrderReason([
            { pubkey: '02aa', sig: 'aa' },
            { pubkey: '03bb', sig: 'bb' }
        ]), null);
    });

    it('reports the first descending PUBKEY pair', function () {
        assert.strictEqual(sigsPubkeyOrderReason([
            { pubkey: '03bb', sig: 'bb' },
            { pubkey: '02aa', sig: 'aa' }
        ]), 'ANCHOR section signatures not PUBKEY-ascending');
    });
});
