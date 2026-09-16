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

describe('co-signer: the envelope on a 2-of-3 account', function () {

    describe('the property the composition exists for', function () {
        it('lets agent+recovery sweep a commit output the daemon can no longer co-sign', async function () {
            const a3 = make2of3();
            const { commit } = envelopeFor3(a3);
            const leaf = commit.recovery.agentRecovery;
            // The daemon is gone: no cancel, no reveal. The operator spends the
            // stranded commit through the leaf the commit tree carries, with the
            // SAME recovery pair the account uses.
            const { txHex } = await buildRecoverySpend({
                account: commit, leafName: 'agentRecovery',
                inputs:  [{ txid: crypto.randomBytes(32).toString('hex'), vout: 0, value: 20000 }],
                outputs: [{ script: a3.account.output, value: 19000 }],
                sign:    localPairSigner(leaf, [a3.agentSk, a3.recSk]),
            });
            const tx = bitcoin.Transaction.fromHex(txHex);
            const w = tx.ins[0].witness;
            expect(w).to.have.length(3);
            expect(w[1].equals(leaf.script)).to.equal(true);
            expect(w[2].equals(leaf.controlBlock)).to.equal(true);
            const sighash = tx.hashForWitnessV1(0, [commit.output], [20000],
                bitcoin.Transaction.SIGHASH_DEFAULT, envelopeLeafHash(leaf.script));
            expect(schnorr.verify(w[0], sighash, leaf.aggregateXOnly)).to.equal(true);
        });

        it('would strand that same output if the leaves were left out (what the old refusal meant)', function () {
            const a3 = make2of3();
            const script = buildEnvelopeScript(a3.account.internalXOnly, ACTION, null);
            const bare = deriveEnvelopeCommit({
                internalXOnly: a3.account.internalXOnly, envelopeScript: script,
            });
            // A single-leaf commit tree has no recovery path at all: the operator
            // pair has nothing to spend through, which is the freeze the 2-of-3
            // exists to prevent.
            expect(bare.recovery).to.equal(null);
            expect(bare.output.equals(envelopeFor3(a3).commit.output)).to.equal(false);
        });
    });
});
