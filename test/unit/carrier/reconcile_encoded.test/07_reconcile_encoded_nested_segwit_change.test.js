// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

// Change returning to a P2SH-P2WPKH funding input is change to the caller's own
// single-key script. The gate recognises it from the redeemScript the PSBT carries,
// and from the caller's pubkey when an encoder answer leaves the redeemScript out.

const assert  = require('assert');
const crypto  = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const ecc     = require('@bitcoinerlab/secp256k1');
const { secp256k1 } = require('@noble/curves/secp256k1.js');
const { reconcileEncoded } = require('../../../../src/carrier/reconcile_encoded.js');
require('../../../../src/utils/apply_bufferutils_patch.js');

bitcoin.initEccLib(ecc);

const NET = bitcoin.networks.regtest;

function newPubkeyHex() {
    return Buffer.from(secp256k1.getPublicKey(crypto.randomBytes(32), true)).toString('hex');
}

// A PSBT spending the key's nested-segwit output with change back to the same script.
function nestedChangePsbt(pubkeyHex, withRedeem) {
    const redeem = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(pubkeyHex, 'hex'), network: NET });
    const nested = bitcoin.payments.p2sh({ redeem, network: NET });
    const psbt = new bitcoin.Psbt({ network: NET });
    const input = { hash: 'cd'.repeat(32), index: 0, witnessUtxo: { script: nested.output, value: 100000 } };
    if (withRedeem) input.redeemScript = redeem.output;
    psbt.addInput(input);
    psbt.addOutput({ script: bitcoin.script.compile([bitcoin.opcodes.OP_RETURN]), value: 0 });
    psbt.addOutput({ script: nested.output, value: 99000 });
    return psbt.toHex();
}

describe('reconcileEncoded nested-segwit change', function () {
    it('authorizes change to a P2SH-P2WPKH input that carries its redeemScript', function () {
        const key = newPubkeyHex();
        assert.strictEqual(reconcileEncoded(nestedChangePsbt(key, true), { network: NET }).fee, 1000n);
    });

    it('authorizes the same change from the caller pubkey when the redeemScript is left out', function () {
        const key = newPubkeyHex();
        const hex = nestedChangePsbt(key, false);
        assert.strictEqual(reconcileEncoded(hex, { network: NET, callerIdentities: key }).fee, 1000n);
        assert.throws(() => reconcileEncoded(hex, { network: NET, callerIdentities: newPubkeyHex() }),
            (e) => e.code === 'UNRECONCILED_OUTPUT');
    });
});
