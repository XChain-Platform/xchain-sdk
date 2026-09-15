// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert  = require('assert');
const crypto  = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const ecc     = require('@bitcoinerlab/secp256k1');
const { secp256k1 } = require('@noble/curves/secp256k1');
const { reconcileEncoded } = require('../../../src/carrier/reconcile_encoded.js');
require('../../../src/utils/apply_bufferutils_patch.js');

bitcoin.initEccLib(ecc);

const NET = bitcoin.networks.regtest;

describe('reconcileEncoded caller-identity change', function () {
    it('authorizes a reveal change output against the caller identity that has no funding script', function () {
        // An envelope or chunk reveal spends ONLY the encoder-derived leg, so rule (b)
        // has nothing to match: without this pin a legitimate reveal is a false
        // positive, and widening rule (d) to cover it would reopen the park.
        const pubkeyHex = Buffer.from(secp256k1.getPublicKey(crypto.randomBytes(32), true)).toString('hex');
        const p2wpkh = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(pubkeyHex, 'hex'), network: NET }).output;
        const leg = bitcoin.payments.p2wsh({ hash: crypto.randomBytes(32), network: NET }).output;

        const psbt = new bitcoin.Psbt({ network: NET });
        psbt.addInput({ hash: 'dd'.repeat(32), index: 0, witnessUtxo: { script: leg, value: 5000 } });
        psbt.addOutput({ script: p2wpkh, value: 4500 });
        const hex = psbt.toHex();

        assert.strictEqual(reconcileEncoded(hex, { network: NET, callerIdentities: pubkeyHex }).fee, 500n);
        // and a DIFFERENT key's address is still an unauthorized destination
        const other = Buffer.from(secp256k1.getPublicKey(crypto.randomBytes(32), true)).toString('hex');
        assert.throws(() => reconcileEncoded(hex, { network: NET, callerIdentities: other }),
                      (e) => e.code === 'UNRECONCILED_OUTPUT');
        // an identity that is neither an address nor a pubkey authorizes nothing
        assert.throws(() => reconcileEncoded(hex, { network: NET, callerIdentities: '03abc' }),
                      (e) => e.code === 'UNRECONCILED_OUTPUT');
    });
});
