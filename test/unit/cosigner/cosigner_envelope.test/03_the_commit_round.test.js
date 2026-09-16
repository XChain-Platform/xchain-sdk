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

    describe('the commit round', function () {
        it('approves a commit, decoding the action from the script it commits to', async function () {
            const acct = makeAccount();
            const { script, commit } = commitFor(acct);
            const co = makeCoSigner(acct);
            const psbt = buildCommitPsbt(acct, commit);
            const res = await runRound(acct, co, psbt, script);
            expect(schnorr.verify(res.signature, res.msg, acct.aggKey)).to.equal(true);
            expect(res.action).to.equal('FILE');
        });

        it('refuses a commit output above maxFeeSats', function () {
            const acct = makeAccount();
            const { script, commit } = commitFor(acct);
            const co = makeCoSigner(acct, { maxFeeSats: 5000 });
            const psbt = buildCommitPsbt(acct, commit, { commitValue: 20000 });
            const out = co.process({
                psbt: psbt.toHex(), envelope: { script: script.toString('hex') },
                inputs: [{ index: 0, agentPublicNonce: Buffer.from(
                    new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk })).toString('hex') }],
            });
            expect(out.approved).to.equal(false);
            expect(out.reason).to.equal('OUTPUT_OVER_CAP');
        });

        it('refuses a commit at all when maxFeeSats is unset (the prefunding would be unbounded)', function () {
            const acct = makeAccount();
            const { script, commit } = commitFor(acct);
            const co = new CoSigner({
                secretKey: acct.coSk, publicKeys: acct.keys, tweaks: [],
                policy: { allowedActions: new Set(['FILE']) },
            });
            const psbt = buildCommitPsbt(acct, commit);
            const out = co.process({
                psbt: psbt.toHex(), envelope: { script: script.toString('hex') },
                inputs: [{ index: 0, agentPublicNonce: Buffer.from(
                    new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk })).toString('hex') }],
            });
            expect(out.approved).to.equal(false);
            expect(out.reason).to.equal('ENVELOPE_COMMIT_UNBOUNDED');
        });

        it('refuses a second commit output (a second, ungated envelope on one tx)', function () {
            const acct = makeAccount();
            const { script, commit } = commitFor(acct);
            const co = makeCoSigner(acct);
            const psbt = buildCommitPsbt(acct, commit, { secondCommitOutput: true });
            const out = co.process({
                psbt: psbt.toHex(), envelope: { script: script.toString('hex') },
                inputs: [{ index: 0, agentPublicNonce: Buffer.from(
                    new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk })).toString('hex') }],
            });
            expect(out.approved).to.equal(false);
            expect(out.reason).to.equal('UNAUTHORIZED_OUTPUT');
        });
    });
});
