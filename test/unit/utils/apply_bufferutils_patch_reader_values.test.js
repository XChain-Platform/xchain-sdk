/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Output value types returned by the patched Transaction readers: fromHex
 * narrows to a Number below 2^53, fromBuffer keeps a BigInt at every size
 * because the PSBT parser sums nonWitnessUtxo values as BigInt. The split is
 * documented in the patch banner; this pins it so a change to either side is
 * a deliberate one.
 */

'use strict';

const assert = require('assert');
const bitcoin = require('bitcoinjs-lib');

require('../../../src/utils/apply_bufferutils_patch.js');

function sampleTx(value) {
    const tx = new bitcoin.Transaction();
    tx.addInput(Buffer.alloc(32, 1), 0);
    tx.addOutput(Buffer.from(`0014${'11'.repeat(20)}`, 'hex'), value);
    return tx;
}

describe('patched Transaction readers output value types', function () {
    it('fromHex narrows a small output value to a Number', function () {
        const tx = bitcoin.Transaction.fromHex(sampleTx(1000).toHex());
        assert.strictEqual(typeof tx.outs[0].value, 'number');
        assert.strictEqual(tx.outs[0].value, 1000);
    });

    it('fromBuffer keeps a small output value as a BigInt', function () {
        const tx = bitcoin.Transaction.fromBuffer(sampleTx(1000).toBuffer());
        assert.strictEqual(typeof tx.outs[0].value, 'bigint');
        assert.strictEqual(tx.outs[0].value, 1000n);
    });

    it('both readers keep a value above 2^53-1 as a BigInt', function () {
        const big = (1n << 60n) + 5n;
        const raw = sampleTx(big);
        assert.strictEqual(bitcoin.Transaction.fromHex(raw.toHex()).outs[0].value, big);
        assert.strictEqual(bitcoin.Transaction.fromBuffer(raw.toBuffer()).outs[0].value, big);
    });
});
