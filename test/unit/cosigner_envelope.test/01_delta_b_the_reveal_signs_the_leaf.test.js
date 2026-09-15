// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//

const {
    expect, crypto, bitcoin, secp256k1, schnorr, MuSig2, CoSigner,
    CoSignerClient, WindowStore, parseEnvelopeScript, deriveEnvelopeCommit,
    envelopeLeafHash, envelopeScriptPathSighash, classifyEnvelopeRole,
    envelopeRoundTweaks, buildRecoverySpend, localPairSigner,
    decodeEnvelopeAction, LEAF_VERSION, ACTION, makeAccount,
    buildEnvelopeScript, commitFor, buildCommitPsbt, buildRevealPsbt,
    buildCancelPsbt, makeCoSigner, runRound, make2of3, client3,
    envelopeFor3, commitPsbt3, revealPsbt3, cancelPsbt3,
    outputKeyFromControlBlock,
} = require('./helpers/support.js');

describe('co-signer: Taproot envelope composition', function () {

    describe('delta (b): the reveal signs the leaf', function () {
        it('produces a signature that verifies under the leaf key over the BIP342 sighash', async function () {
            const acct = makeAccount();
            const { script, commit } = commitFor(acct);
            const co = makeCoSigner(acct);
            const psbt = buildRevealPsbt(acct, commit);

            const res = await runRound(acct, co, psbt, script);
            const msg = envelopeScriptPathSighash(psbt, 0, undefined, commit.leafHash);
            expect(Buffer.from(res.msg).equals(msg)).to.equal(true);
            // The leaf's OP_CHECKSIG key is the BARE aggregate: no tweak.
            expect(schnorr.verify(res.signature, msg, acct.aggKey)).to.equal(true);
        });

        it('is NOT a key-path signature (the two messages differ)', function () {
            const acct = makeAccount();
            const { commit } = commitFor(acct);
            const psbt = buildRevealPsbt(acct, commit);
            const scriptPath = envelopeScriptPathSighash(psbt, 0, undefined, commit.leafHash);
            const tx = new bitcoin.Transaction();
            tx.version = psbt.version; tx.locktime = psbt.locktime;
            for (const ti of psbt.txInputs) tx.addInput(ti.hash, ti.index, ti.sequence);
            for (const to of psbt.txOutputs) tx.addOutput(to.script, to.value);
            const keyPath = tx.hashForWitnessV1(0, [commit.output], [20000], bitcoin.Transaction.SIGHASH_DEFAULT);
            expect(scriptPath.equals(keyPath)).to.equal(false);
        });

        // The reveal derivation is a public export, so it must fail closed on
        // its own rather than trust process()'s step-8 gate to have run first.
        // Its key-path twin has always refused these types; this pins the twin.
        it('refuses to derive a reveal message under a sighash type that does not commit to every output', function () {
            const acct = makeAccount();
            const { commit } = commitFor(acct);
            const psbt = buildRevealPsbt(acct, commit);
            for (const ht of [
                bitcoin.Transaction.SIGHASH_ALL,       // 0x01: valid on taproot, but not what this signer finalizes
                bitcoin.Transaction.SIGHASH_NONE,      // 0x02
                bitcoin.Transaction.SIGHASH_SINGLE,    // 0x03
                bitcoin.Transaction.SIGHASH_ALL | bitcoin.Transaction.SIGHASH_ANYONECANPAY,
            ]) {
                expect(() => envelopeScriptPathSighash(psbt, 0, ht, commit.leafHash))
                    .to.throw(/disallowed sighashType/);
            }
            // SIGHASH_DEFAULT, and an unspecified type, still derive normally.
            expect(envelopeScriptPathSighash(psbt, 0, undefined, commit.leafHash)).to.have.length(32);
            expect(envelopeScriptPathSighash(psbt, 0, bitcoin.Transaction.SIGHASH_DEFAULT, commit.leafHash))
                .to.have.length(32);
        });
    });
});
