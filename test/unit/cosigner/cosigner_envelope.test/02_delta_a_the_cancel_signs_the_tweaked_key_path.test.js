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

    describe('delta (a): the cancel signs the tweaked key path', function () {
        it('produces a signature that verifies under the TWEAKED output key', async function () {
            const acct = makeAccount();
            const { script, commit } = commitFor(acct);
            const co = makeCoSigner(acct);
            const psbt = buildCancelPsbt(acct, commit);

            const res = await runRound(acct, co, psbt, script);
            // The output key is what a key-path spend of the commit verifies
            // under, and it commits to the envelope leaf.
            expect(schnorr.verify(res.signature, res.msg, commit.outputXOnly)).to.equal(true);
            // ... and NOT under the untweaked aggregate, which is the whole point.
            expect(schnorr.verify(res.signature, res.msg, acct.aggKey)).to.equal(false);
        });

        it('derives the tweak rather than accepting one (G3 stays closed)', function () {
            const acct = makeAccount();
            expect(() => new CoSigner({
                secretKey: acct.coSk, publicKeys: acct.keys,
                tweaks: [{ tweak: crypto.randomBytes(32), xOnly: true }],
                policy: { allowedActions: new Set(['FILE']) },
            })).to.throw();
        });
    });
});
