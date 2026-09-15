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
const { reconcileEncoded, psbtPrevouts } = require('../../../src/carrier/reconcile_encoded.js');
require('../../../src/utils/apply_bufferutils_patch.js');

bitcoin.initEccLib(ecc);

const NET = bitcoin.networks.regtest;

function payTo() {
    const pubkey = Buffer.from(secp256k1.getPublicKey(crypto.randomBytes(32), true));
    const p = bitcoin.payments.p2wpkh({ pubkey, network: NET });
    return { script: p.output, address: p.address };
}

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

// ---------------------------------------------------------------------------
// Shape alone is not an authorization.
//
// Rule (d) let any p2sh/p2wsh/p2tr output through on shape, and the maxFeeSats
// ceiling never bounded it: a parked output raises totalOut, which LOWERS the
// computed fee, so the cap the code claimed as the residual's bound did nothing.
// The pins below replace that claim with two real ones - the companion PSBT for a
// phase whose consumer already exists, the recovery check for one whose consumer
// arrives later - plus an opt-in value cap for the window neither covers.
// ---------------------------------------------------------------------------

// A p2wsh script for a fresh 32-byte witness program, the shape of a chunk leg.
const shapedP2wsh = () => bitcoin.payments.p2wsh({ hash: crypto.randomBytes(32), network: NET }).output;
const shapedP2tr  = () => bitcoin.script.compile([bitcoin.opcodes.OP_1, crypto.randomBytes(32)]);

// An unsigned PSBT spending the given [{ script, value }] prevouts.
function spendingPsbt(prevouts, outputs) {
    const psbt = new bitcoin.Psbt({ network: NET });
    prevouts.forEach((p, i) => psbt.addInput({
        hash: 'bb'.repeat(32), index: i,
        witnessUtxo: { script: p.script, value: Number(p.value) },
    }));
    for (const out of outputs) psbt.addOutput(out);
    return psbt.toHex();
}

describe('reconcileEncoded funding-leg pins', function () {
    it('psbtPrevouts reads what a PSBT spends, and refuses a partial answer', function () {
        const leg = { script: shapedP2tr(), value: 7000n };
        const prevouts = psbtPrevouts(spendingPsbt([leg], [{ script: payTo().script, value: 6000 }]));
        assert.strictEqual(prevouts.length, 1);
        assert.ok(prevouts[0].script.equals(leg.script));
        assert.strictEqual(prevouts[0].value, 7000n);
        assert.strictEqual(psbtPrevouts('not-a-psbt'), null);
        // An input with no UTXO data yields null rather than a shorter list: a partial
        // list would silently weaken every pin built on it.
        const partial = new bitcoin.Psbt({ network: NET });
        partial.addInput({ hash: 'cc'.repeat(32), index: 0 });
        partial.addOutput({ script: payTo().script, value: 1000 });
        assert.strictEqual(psbtPrevouts(partial.toHex()), null);
    });

    it('pins an envelope commit leg to what the reveal actually spends', function () {
        // The pair comes back from ONE createTx call, so the reveal's inputs are
        // readable before the commit is signed. This is the whole closure for the
        // envelope phase: shape gets the leg considered, the reveal authorizes it.
        const funding = payTo();
        const commitScript = shapedP2tr();
        const commit = psbtHex(funding, [{ script: commitScript, value: 8000 }, { script: funding.script, value: 85000 }]);
        const reveal = spendingPsbt([{ script: commitScript, value: 8000n }], [{ script: funding.script, value: 7500 }]);
        const r = reconcileEncoded(commit, { network: NET, phaseShapes: ['p2tr'], phaseSpends: psbtPrevouts(reveal) });
        assert.strictEqual(r.phaseFunding.length, 1);
        assert.strictEqual(r.phaseFunding[0].value, 8000n);
    });

    it('REJECTS value parked in a shaped script the reveal never spends', function () {
        // The attack the shape-only rule allowed: a second, correctly shaped output
        // that only the encoder can spend, riding along with the real commit.
        const funding = payTo();
        const commitScript = shapedP2tr(), parked = shapedP2tr();
        const commit = psbtHex(funding, [
            { script: commitScript, value: 8000 },
            { script: parked,       value: 80000 },
            { script: funding.script, value: 5000 },
        ]);
        const reveal = spendingPsbt([{ script: commitScript, value: 8000n }], [{ script: funding.script, value: 7500 }]);
        assert.throws(
            () => reconcileEncoded(commit, { network: NET, phaseShapes: ['p2tr'], phaseSpends: psbtPrevouts(reveal) }),
            (e) => e.code === 'PHASE_FUNDING_UNSPENT' && e.details.detail.script === parked.toString('hex'));
        // Shape alone still lets it through, which is exactly the finding.
        assert.strictEqual(reconcileEncoded(commit, { network: NET, phaseShapes: ['p2tr'] }).phaseFunding.length, 2);
    });
});

describe('reconcileEncoded funding-leg pins', function () {
    it('REJECTS an over-funded leg even when the reveal spends that script', function () {
        // Inflating the commit and spending "it" is the same theft with one step
        // removed, so the pin matches on value as well as script.
        const funding = payTo();
        const commitScript = shapedP2tr();
        const commit = psbtHex(funding, [{ script: commitScript, value: 90000 }]);
        const reveal = spendingPsbt([{ script: commitScript, value: 8000n }], [{ script: funding.script, value: 7500 }]);
        assert.throws(
            () => reconcileEncoded(commit, { network: NET, phaseShapes: ['p2tr'], phaseSpends: psbtPrevouts(reveal) }),
            (e) => e.code === 'PHASE_FUNDING_UNSPENT');
    });

    it('N identical legs need N distinct spends, not one spend reused', function () {
        const funding = payTo();
        const leg = shapedP2wsh();
        const commit = psbtHex(funding, [{ script: leg, value: 3000 }, { script: leg, value: 3000 }, { script: funding.script, value: 90000 }]);
        const one = spendingPsbt([{ script: leg, value: 3000n }], [{ script: funding.script, value: 2500 }]);
        assert.throws(
            () => reconcileEncoded(commit, { network: NET, phaseShapes: ['p2wsh'], phaseSpends: psbtPrevouts(one) }),
            (e) => e.code === 'PHASE_FUNDING_UNSPENT');
        const both = spendingPsbt([{ script: leg, value: 3000n }, { script: leg, value: 3000n }], [{ script: funding.script, value: 5500 }]);
        assert.strictEqual(reconcileEncoded(commit, { network: NET, phaseShapes: ['p2wsh'], phaseSpends: psbtPrevouts(both) }).phaseFunding.length, 2);
    });

    it('an EMPTY companion prevout list authorizes nothing (absent is not the same as none)', function () {
        const funding = payTo();
        const commit = psbtHex(funding, [{ script: shapedP2tr(), value: 8000 }, { script: funding.script, value: 85000 }]);
        assert.throws(
            () => reconcileEncoded(commit, { network: NET, phaseShapes: ['p2tr'], phaseSpends: [] }),
            (e) => e.code === 'PHASE_FUNDING_UNSPENT');
        assert.doesNotThrow(() => reconcileEncoded(commit, { network: NET, phaseShapes: ['p2tr'] }));
    });

    it('requires a later phase to spend back every leg the earlier one funded', function () {
        // A chunked action has no companion PSBT at phase 1 (spendP2sh is only callable
        // once phase 1 is on chain), so the pin runs the other way round: phase 2 must
        // consume the whole set. A chunk it does not reveal is undecodable AND is value
        // the encoder kept, so a legitimate reveal never trips this.
        const funding = payTo();
        const legs = [{ script: shapedP2wsh(), value: 3000n }, { script: shapedP2wsh(), value: 3000n }];
        const full = spendingPsbt(legs, [carrier(0), { script: funding.script, value: 5000 }]);
        const back = { network: NET, requiredSpends: legs, changeAddresses: funding.address };
        assert.doesNotThrow(() => reconcileEncoded(full, back));
        const partial = spendingPsbt([legs[0]], [carrier(0), { script: funding.script, value: 2500 }]);
        assert.throws(
            () => reconcileEncoded(partial, back),
            (e) => e.code === 'PHASE_FUNDING_UNSPENT' && e.details.detail.script === legs[1].script.toString('hex'));
    });
});

describe('reconcileEncoded funding-leg pins', function () {
    it('caps the total value an encoder may put into shaped legs, when the caller sets one', function () {
        const funding = payTo();
        const hex = psbtHex(funding, [
            { script: shapedP2wsh(), value: 20000 },
            { script: shapedP2wsh(), value: 20000 },
            { script: funding.script, value: 50000 },
        ]);
        const intent = { network: NET, phaseShapes: ['p2wsh'] };
        assert.throws(
            () => reconcileEncoded(hex, Object.assign({ maxPhaseFundingSats: 39999 }, intent)),
            (e) => e.code === 'PHASE_FUNDING_OVER_CAP');
        assert.doesNotThrow(() => reconcileEncoded(hex, Object.assign({ maxPhaseFundingSats: 40000 }, intent)));
        assert.doesNotThrow(() => reconcileEncoded(hex, intent));
    });

    it('the fee cap never bounded a parked leg, which is why the cap above exists', function () {
        // Pinning the premise of the fix: 90000 sat diverted into a shaped output
        // leaves a 10000 sat fee, so even a tight maxFeeSats passes it.
        const funding = payTo();
        const hex = psbtHex(funding, [{ script: shapedP2wsh(), value: 90000 }]);
        const r = reconcileEncoded(hex, { network: NET, phaseShapes: ['p2wsh'], maxFeeSats: 10000 });
        assert.strictEqual(r.fee, 10000n);
        assert.throws(
            () => reconcileEncoded(hex, { network: NET, phaseShapes: ['p2wsh'], maxFeeSats: 10000, maxPhaseFundingSats: 5000 }),
            (e) => e.code === 'PHASE_FUNDING_OVER_CAP');
    });
});
