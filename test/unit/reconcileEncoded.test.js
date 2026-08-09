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
// Teaches bitcoinjs/bip174 to carry satoshi values above 2^53 as BigInt; the >2^53
// fee-cap case below cannot build its PSBT without it.
require('../../src/applyBufferutilsPatch.js');

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

    it('#3922: a string-valued cap is parsed exactly, not through a rounding Number() hop', function () {
        // intent.customOutputs[].value may legitimately be a decimal string (the
        // encoder's allowBig path). toU64(Number(v)) returned null for a string, which
        // zeroed the cap and DENIED an honest reconcile; Number() alone would round a
        // >2^53 cap. Both directions are asserted here.
        const funding = payTo(), recipient = payTo();
        const intent = { network: NET, customOutputs: [{ address: recipient.address, value: '20000' }] };
        const ok = psbtHex(funding, [carrier(0), { script: recipient.script, value: 20000 }, { script: funding.script, value: 70000 }]);
        assert.strictEqual(reconcileEncoded(ok, intent).fee, 10000n);

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

    it(': a >2^53 fee cap is compared exactly, not through a rounding Number() hop', function () {
        // DOGE has no supply cap, so a fee this size is reachable rather than
        // hypothetical. Number('9007199254740993') is 9007199254740992, so the cap
        // arrived one satoshi SHORT of what the caller set and an honest fee landing
        // exactly on it was denied; a bigint cap rounded identically. Both accept
        // directions and the deny direction are asserted, since a cap that rounds
        // the other way would slacken the guard instead.
        const funding = payTo();
        const IN     = 18014398509481985n;  // 2^54 + 1
        const CHANGE = 9007199254740992n;   // 2^53
        const FEE    = IN - CHANGE;         // 2^53 + 1, the first value a double cannot hold

        const psbt = new bitcoin.Psbt({ network: NET });
        psbt.addInput({ hash: 'aa'.repeat(32), index: 0, witnessUtxo: { script: funding.script, value: IN } });
        psbt.addOutput(carrier(0));
        psbt.addOutput({ script: funding.script, value: CHANGE });
        const hex = psbt.toHex();

        assert.strictEqual(reconcileEncoded(hex, { network: NET, maxFeeSats: String(FEE) }).fee, FEE);
        assert.strictEqual(reconcileEncoded(hex, { network: NET, maxFeeSats: FEE }).fee, FEE);
        assert.throws(
            () => reconcileEncoded(hex, { network: NET, maxFeeSats: FEE - 1n }),
            (e) => e.code === 'FEE_OVER_CAP');
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

    it('a submitted P2SH change address is change, not a funding leg ', function () {
        // It decompiles identically to a chunk output, so without the submitted-change
        // rule it would be classified as a leg and the next phase would be required to
        // spend it back - a false positive on an address the caller chose.
        const funding = payTo();
        const change = bitcoin.payments.p2sh({ hash: crypto.randomBytes(20), network: NET });
        const hex = psbtHex(funding, [carrier(0), { script: change.output, value: 90000 }]);
        const r = reconcileEncoded(hex, { network: NET, phaseShapes: ['p2sh'], changeAddresses: change.address });
        assert.strictEqual(r.fee, 10000n);
        assert.deepStrictEqual(r.phaseFunding, [], 'the caller own change is never a leg to pin');
        // and an address the caller did NOT submit is still just a shaped output
        const other = bitcoin.payments.p2sh({ hash: crypto.randomBytes(20), network: NET });
        assert.throws(
            () => reconcileEncoded(psbtHex(funding, [carrier(0), { script: other.output, value: 90000 }]),
                                   { network: NET, changeAddresses: change.address }),
            (e) => e.code === 'UNRECONCILED_OUTPUT');
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

// ---------------------------------------------------------------------------
// : shape alone is not an authorization.
//
// Rule (d) let any p2sh/p2wsh/p2tr output through on shape, and the maxFeeSats
// ceiling never bounded it: a parked output raises totalOut, which LOWERS the
// computed fee, so the cap the code claimed as the residual's bound did nothing.
// The pins below replace that claim with two real ones - the companion PSBT for a
// phase whose consumer already exists, the recovery check for one whose consumer
// arrives later - plus an opt-in value cap for the window neither covers.
// ---------------------------------------------------------------------------

const { psbtPrevouts } = require('../../src/reconcileEncoded.js');

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

describe('reconcileEncoded funding-leg pins ', function () {

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
        // envelope lane: shape gets the leg considered, the reveal authorizes it.
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

describe('reconcileEncoded caller-identity change ', function () {

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
