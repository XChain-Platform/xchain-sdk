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
 * The two-step multipart commit is signed and handed back to the encoder, so it
 * is pinned and reconciled before that signature exists. Real PSBTs go through
 * the real pins and the real reconcileEncoded, with the same intent the
 * workflow builds.
 */

'use strict';

const assert = require('assert');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('@bitcoinerlab/secp256k1');
const { ECPair } = require('../../../src/utils/wallet/key_derivation.js');
const { twoStepCommitPins } = require('../../../src/file/multipart_two_step_pins.js');
const { reconcileEncoded } = require('../../../src/carrier/reconcile_encoded.js');
const { deriveEnvelopeCommit } = require('../../../src/cosigner/envelope.js');

bitcoin.initEccLib(ecc);

const NET = bitcoin.networks.regtest;
const CALLER = ECPair.fromPrivateKey(Buffer.alloc(32, 7), { network: NET });
const ATTACKER = ECPair.fromPrivateKey(Buffer.alloc(32, 8), { network: NET });
const xOnly = pair => Buffer.from(pair.publicKey).subarray(1, 33);
const SOURCE = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(CALLER.publicKey), network: NET });
const UTXO = { txid: '11'.repeat(32), vout: 0, value: 100000, scriptPubKey: SOURCE.output.toString('hex') };

function leafFor(key) {
    return bitcoin.script.compile([bitcoin.opcodes.OP_0, bitcoin.opcodes.OP_IF,
        Buffer.from('XCHN'), Buffer.from([0]), Buffer.from('FILE|0|part'),
        bitcoin.opcodes.OP_ENDIF, key, bitcoin.opcodes.OP_CHECKSIG]);
}

function commitOutput(key) {
    return deriveEnvelopeCommit({ internalXOnly: key, envelopeScript: leafFor(key), network: NET }).output;
}

// An honest two-step commit as the encoder builds it: the piece utxo in, the
// commit output and change out, with the leaf reported in carrierScripts.
function honest({ inputs = [UTXO], outputs, leafKey = xOnly(CALLER), scripts } = {}) {
    const psbt = new bitcoin.Psbt({ network: NET });
    for (const input of inputs) {
        psbt.addInput({ hash: input.txid, index: input.vout,
            witnessUtxo: { script: Buffer.from(input.scriptPubKey, 'hex'), value: BigInt(input.value) } });
    }
    const outs = outputs || [{ script: commitOutput(xOnly(CALLER)), value: 50000n },
        { script: SOURCE.output, value: 49000n }];
    for (const out of outs) psbt.addOutput(out);
    const carrierScripts = scripts || [leafFor(leafKey).toString('hex')];
    return { psbt: psbt.toHex(), carrierScripts };
}

function preSign(commit, caps = {}, utxo = UTXO) {
    const pins = twoStepCommitPins({ commit, utxo, callerXOnly: xOnly(CALLER), network: NET });
    reconcileEncoded(commit.psbt, { network: NET, changeAddresses: SOURCE.address,
        callerIdentities: Buffer.from(CALLER.publicKey).toString('hex'), label: 'multipart envelope commit pre-sign',
        phaseShapes: ['p2tr'], phaseSpends: pins.phaseSpends, requiredSpends: pins.requiredSpends, ...caps });
    return pins;
}

const refusedWith = (code, reason) => error => error.code === code
    && (reason === undefined || (error.details && error.details.reason === reason));

describe('two-step multipart commit pre-sign gate', function () {
    it('passes an honest commit and scopes signing to its one input', function () {
        const pins = preSign(honest(), { maxFeeSats: 5000, maxPhaseFundingSats: 60000 });
        assert.deepStrictEqual(pins.inputIndices, [0]);
    });

    it('refuses a commit that spends an extra wallet input', function () {
        const extra = { txid: '22'.repeat(32), vout: 1, value: 90000, scriptPubKey: UTXO.scriptPubKey };
        assert.throws(() => preSign(honest({ inputs: [UTXO, extra] })),
            refusedWith('ENVELOPE_COMMIT_MISMATCH', 'INPUT_COUNT'));
    });

    it('refuses a commit that spends a different outpoint', function () {
        assert.throws(() => preSign(honest({ inputs: [{ ...UTXO, vout: 3 }] })),
            refusedWith('ENVELOPE_COMMIT_MISMATCH', 'INPUT_OUTPOINT_MISMATCH'));
    });

    it('refuses a missing or malformed carrierScripts answer', function () {
        for (const scripts of [[], ['zz'], [leafFor(xOnly(CALLER)).toString('hex'), 'aa'], 'aa', null]) {
            assert.throws(() => preSign({ ...honest(), carrierScripts: scripts }),
                refusedWith('ENVELOPE_COMMIT_MISMATCH', 'CARRIER_SCRIPTS_INVALID'));
        }
    });

    it('refuses a leaf built for another key', function () {
        assert.throws(() => preSign(honest({ leafKey: xOnly(ATTACKER) })),
            refusedWith('ENVELOPE_COMMIT_MISMATCH', 'CALLER_KEY_MISMATCH'));
    });

    it('refuses a commit whose only Taproot output belongs to someone else', function () {
        const outputs = [{ script: commitOutput(xOnly(ATTACKER)), value: 50000n },
            { script: SOURCE.output, value: 49000n }];
        assert.throws(() => preSign(honest({ outputs })),
            refusedWith('ENVELOPE_COMMIT_MISMATCH', 'COMMIT_OUTPUT_COUNT'));
    });

    it('refuses the correct commit output plus an extra Taproot output, with no caps set', function () {
        const outputs = [{ script: commitOutput(xOnly(CALLER)), value: 50000n },
            { script: commitOutput(xOnly(ATTACKER)), value: 30000n },
            { script: SOURCE.output, value: 19000n }];
        assert.throws(() => preSign(honest({ outputs })), refusedWith('PHASE_FUNDING_UNSPENT'));
    });

    it('refuses an input whose value differs from the planned funding output', function () {
        assert.throws(() => preSign(honest({ inputs: [{ ...UTXO, value: 900000 }] })),
            refusedWith('PHASE_FUNDING_UNSPENT'));
    });

    it('refuses a fee above the caller cap', function () {
        assert.throws(() => preSign(honest(), { maxFeeSats: 500 }), refusedWith('FEE_OVER_CAP'));
    });
});
