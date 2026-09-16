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

    describe('both halves derive the tree, neither is told it', function () {
        it('makes a 2-of-2-shaped client and a 2-of-3 daemon disagree rather than half-agree', async function () {
            const a3 = make2of3();
            const { script, commit } = envelopeFor3(a3);
            // A client that forgot its recovery key composes the single-leaf tree,
            // so the commit output it would fund is not the one the daemon derives.
            const naive = new CoSignerClient({
                transport: CoSignerClient.inProcessTransport(a3.co),
                publicKeys: a3.keys, tweaks: a3.account.keyPath.tweaks,
            });
            let err = null;
            try {
                await naive.sign({ psbt: commitPsbt3(a3, commit).toHex(), secretKey: a3.agentSk,
                    envelopeScript: script.toString('hex') });
            } catch (e) { err = e; }
            expect(err).to.not.equal(null);
            // It fails on its OWN derivation (the leaf key it computes is the
            // tweaked output key), before anything reaches the daemon.
            expect(err.message).to.match(/different key|neither funds nor spends/);
        });

        it('rejects a client whose configured tweaks disagree with the derived tree', function () {
            const a3 = make2of3();
            expect(() => client3(a3, { tweaks: [] })).to.throw(/does not match the tweak derived/);
            expect(() => client3(a3, { tweaks: a3.account.keyPath.tweaks })).to.not.throw();
        });

        it('derives the key-path tweak itself when the client is given no tweaks', function () {
            const a3 = make2of3();
            const c = client3(a3);
            expect(c.aggregateXOnly.equals(a3.account.outputXOnly)).to.equal(true);
            expect(c.internalXOnly.equals(a3.account.internalXOnly)).to.equal(true);
        });
    });
});
