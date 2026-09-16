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

// The envelope surface on a 2-of-3 account. The decision this suite
// pins is that a commit output of a 2-of-3 keeps the two-of-three property,
// its tree carries the account's own recovery leaves next to the envelope leaf,
// rather than stranding the prefunded reveal fee behind a lost co-signer.
describe('co-signer: the envelope on a 2-of-3 account', function () {

    describe('the composed commit tree', function () {
        it('puts the envelope leaf and both account recovery leaves in one tree', function () {
            const a3 = make2of3();
            const { script, commit } = envelopeFor3(a3);
            const leafAR = a3.account.recovery.agentRecovery.script;
            const leafDR = a3.account.recovery.daemonRecovery.script;

            // The address is a plain bitcoinjs p2tr over the declared shape:
            // [ envelope , [ agentRecovery , daemonRecovery ] ], internal key =
            // the untweaked cooperative aggregate.
            const ref = bitcoin.payments.p2tr({
                internalPubkey: a3.account.internalXOnly,
                scriptTree: [{ output: script }, [{ output: leafAR }, { output: leafDR }]],
            });
            expect(commit.output.equals(ref.output)).to.equal(true);
            expect(commit.address).to.equal(ref.address);
            // The recovery leaves are the ACCOUNT's own leaves, byte for byte:
            // no new key material, and the operator's recovery pair is unchanged.
            expect(commit.recovery.agentRecovery.script.equals(leafAR)).to.equal(true);
            expect(commit.recovery.daemonRecovery.script.equals(leafDR)).to.equal(true);
        });

        it('gives the hot reveal path the short control block and recovery the long one', function () {
            const a3 = make2of3();
            const { commit } = envelopeFor3(a3);
            expect(commit.controlBlock).to.have.length(65);            // depth 1
            expect(commit.recovery.agentRecovery.controlBlock).to.have.length(97);   // depth 2
            expect(commit.recovery.daemonRecovery.controlBlock).to.have.length(97);
        });

        it('every leaf control block proves a real path to the commit output key', function () {
            const a3 = make2of3();
            const { script, commit } = envelopeFor3(a3);
            const leaves = [
                [commit.controlBlock, script],
                [commit.recovery.agentRecovery.controlBlock, commit.recovery.agentRecovery.script],
                [commit.recovery.daemonRecovery.controlBlock, commit.recovery.daemonRecovery.script],
            ];
            for (const [cb, leafScript] of leaves) {
                const got = outputKeyFromControlBlock(cb, leafScript);
                expect(got.xOnly.equals(commit.outputXOnly)).to.equal(true);
                expect(got.parity).to.equal(cb[0] & 1);
                expect(cb.subarray(1, 33).equals(a3.account.internalXOnly)).to.equal(true);
            }
        });
    });
});

describe('co-signer: the envelope on a 2-of-3 account', function () {

    describe('the composed commit tree', function () {
        it('keeps leafHash the TAPLEAF hash once the tree has more than one leaf', function () {
            const a3 = make2of3();
            const { script, commit } = envelopeFor3(a3);
            // On the single-leaf 2-of-2 tree these coincide; here they must not,
            // and the reveal sighash needs the leaf hash, never the root.
            expect(commit.leafHash.equals(envelopeLeafHash(script))).to.equal(true);
            expect(commit.leafHash.equals(commit.merkleRoot)).to.equal(false);
        });

        it('refuses a recovery pair that is not two distinct leaves', function () {
            const a3 = make2of3();
            const script = buildEnvelopeScript(a3.account.internalXOnly, ACTION, null);
            const dup = a3.account.recovery.agentRecovery;
            expect(() => deriveEnvelopeCommit({
                internalXOnly: a3.account.internalXOnly, envelopeScript: script,
                recoveryLeaves: { agentRecovery: dup, daemonRecovery: dup },
            })).to.throw(/distinct/);
            expect(() => deriveEnvelopeCommit({
                internalXOnly: a3.account.internalXOnly, envelopeScript: script,
                recoveryLeaves: { agentRecovery: dup },
            })).to.throw(/daemonRecovery/);
        });
    });
});
