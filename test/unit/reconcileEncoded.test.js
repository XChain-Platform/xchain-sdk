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
const { reconcileEncoded } = require('../../src/reconcileEncoded.js');

bitcoin.initEccLib(ecc);

const NET = bitcoin.networks.regtest;

// A p2wpkh script + address for a fresh key.
function payTo() {
    const pubkey = Buffer.from(secp256k1.getPublicKey(crypto.randomBytes(32), true));
    const p = bitcoin.payments.p2wpkh({ pubkey, network: NET });
    return { script: p.output, address: p.address };
}

// Build an unsigned PSBT: one 100000-sat input from `funding`, plus `outputs`.
function psbtHex(funding, outputs) {
    const psbt = new bitcoin.Psbt({ network: NET });
    psbt.addInput({
        hash: 'aa'.repeat(32), index: 0,
        witnessUtxo: { script: funding.script, value: 100000 },
    });
    for (const out of outputs) psbt.addOutput(out);
    return psbt.toHex();
}

const carrier = (value) => ({ script: bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, Buffer.from('58434841494e', 'hex')]), value });

describe('reconcileEncoded (encoder-authored PSBT vs submitted intent)', function () {

    it('accepts the ordinary shape: a zero-value carrier plus change back to the funding script', function () {
        const funding = payTo();
        const r = reconcileEncoded(psbtHex(funding, [carrier(0), { script: funding.script, value: 90000 }]), { network: NET });
        assert.strictEqual(r.fee, 10000n);
        assert.strictEqual(r.totalOut, 90000n);
    });

    it('REJECTS an output nobody asked for - the fund-redirection case', function () {
        // The encoder is remote, so this is the whole point of the gate: a benign
        // action string with the coin quietly pointed somewhere else.
        const funding = payTo(), attacker = payTo();
        assert.throws(
            () => reconcileEncoded(psbtHex(funding, [carrier(0), { script: attacker.script, value: 90000 }]), { network: NET }),
            (e) => e.code === 'UNRECONCILED_OUTPUT');
    });

    it('accepts a customOutput the caller submitted, and caps it at the submitted value', function () {
        const funding = payTo(), recipient = payTo();
        const intent = { network: NET, customOutputs: [{ address: recipient.address, value: 20000 }] };
        const ok = psbtHex(funding, [carrier(0), { script: recipient.script, value: 20000 }, { script: funding.script, value: 70000 }]);
        assert.strictEqual(reconcileEncoded(ok, intent).fee, 10000n);

        // Same authorized address, more value than was ever requested.
        const over = psbtHex(funding, [carrier(0), { script: recipient.script, value: 90000 }]);
        assert.throws(() => reconcileEncoded(over, intent), (e) => e.code === 'OUTPUT_OVER_REQUESTED_VALUE');
    });

    it('caps repeated outputs to one authorized address on their SUM, not each alone', function () {
        const funding = payTo(), recipient = payTo();
        const intent = { network: NET, customOutputs: [{ address: recipient.address, value: 20000 }] };
        const split = psbtHex(funding, [{ script: recipient.script, value: 15000 }, { script: recipient.script, value: 15000 }]);
        assert.throws(() => reconcileEncoded(split, intent), (e) => e.code === 'OUTPUT_OVER_REQUESTED_VALUE');
    });

    it('REJECTS value assigned to the OP_RETURN carrier - a drain by destruction', function () {
        const funding = payTo();
        assert.throws(
            () => reconcileEncoded(psbtHex(funding, [carrier(90000)]), { network: NET }),
            (e) => e.code === 'OP_RETURN_CARRIES_VALUE');
    });

    it('REJECTS the full burn, where every satoshi becomes miner fee', function () {
        const funding = payTo();
        assert.throws(
            () => reconcileEncoded(psbtHex(funding, [carrier(0)]), { network: NET }),
            (e) => e.code === 'FULL_BURN_FEE');
    });

    it('REJECTS a value-negative transaction', function () {
        const funding = payTo();
        assert.throws(
            () => reconcileEncoded(psbtHex(funding, [{ script: funding.script, value: 200000 }]), { network: NET }),
            (e) => e.code === 'NEGATIVE_FEE');
    });

    it('enforces maxFeeSats when the caller sets one, and stays quiet when it does not', function () {
        const funding = payTo();
        const hex = psbtHex(funding, [carrier(0), { script: funding.script, value: 90000 }]);
        assert.throws(() => reconcileEncoded(hex, { network: NET, maxFeeSats: 5000 }), (e) => e.code === 'FEE_OVER_CAP');
        assert.strictEqual(reconcileEncoded(hex, { network: NET, maxFeeSats: 10000 }).fee, 10000n);
        assert.strictEqual(reconcileEncoded(hex, { network: NET }).fee, 10000n);
    });

    it('authorizes an encoder-derived funding leg only for the phase that has one', function () {
        // A two-phase P2SH action funds chunk outputs whose scripts the SDK cannot
        // predict; the same output on a single-phase action is unauthorized value.
        const funding = payTo();
        const chunk = bitcoin.payments.p2sh({ hash: crypto.randomBytes(20), network: NET }).output;
        const hex = psbtHex(funding, [{ script: chunk, value: 40000 }, { script: funding.script, value: 50000 }]);
        assert.strictEqual(reconcileEncoded(hex, { network: NET, phaseShapes: ['p2sh', 'p2wsh'] }).fee, 10000n);
        assert.throws(() => reconcileEncoded(hex, { network: NET }), (e) => e.code === 'UNRECONCILED_OUTPUT');
        // A plain payment is never a funding leg, whatever phase is running.
        const attacker = payTo();
        const drain = psbtHex(funding, [{ script: attacker.script, value: 90000 }]);
        assert.throws(() => reconcileEncoded(drain, { network: NET, phaseShapes: ['p2sh', 'p2wsh'] }), (e) => e.code === 'UNRECONCILED_OUTPUT');
    });

    it('fails closed on a PSBT it cannot read', function () {
        assert.throws(() => reconcileEncoded('not-a-psbt', { network: NET }), (e) => e.code === 'UNRECONCILABLE_PSBT');
        // An input with no UTXO data has no establishable funding script; bitcoinjs
        // could not sign it either, so refusing is not a false positive.
        const psbt = new bitcoin.Psbt({ network: NET });
        psbt.addInput({ hash: 'aa'.repeat(32), index: 0 });
        psbt.addOutput({ script: payTo().script, value: 1000 });
        assert.throws(() => reconcileEncoded(psbt.toHex(), { network: NET }), (e) => e.code === 'UNRECONCILABLE_PSBT');
    });
});
