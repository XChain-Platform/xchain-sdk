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

    describe('the 2-of-2 account is untouched', function () {
        it('still derives a single-leaf commit tree with leafHash === merkleRoot', function () {
            const acct = makeAccount();
            const { commit } = commitFor(acct);
            expect(commit.recovery).to.equal(null);
            expect(commit.leafHash.equals(commit.merkleRoot)).to.equal(true);
            expect(commit.controlBlock).to.have.length(33);
        });

        it('selects the same tweak set the inline conditional used to', function () {
            const accountTweaks = [{ tweak: crypto.randomBytes(32), xOnly: true }];
            const commit = { tweak: crypto.randomBytes(32) };
            expect(envelopeRoundTweaks(null, accountTweaks)).to.equal(accountTweaks);
            expect(envelopeRoundTweaks({ role: 'commit', commit }, accountTweaks)).to.equal(accountTweaks);
            expect(envelopeRoundTweaks({ role: 'reveal', commit }, accountTweaks)).to.deep.equal([]);
            expect(envelopeRoundTweaks({ role: 'cancel', commit }, accountTweaks))
                .to.deep.equal([{ tweak: commit.tweak, xOnly: true }]);
        });
    });
});
