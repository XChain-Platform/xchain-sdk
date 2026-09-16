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

    describe('all three envelope rounds complete on a 2-of-3', function () {
        it('commits under the account key path (the tap-tweaked 2-of-3 output key)', async function () {
            const a3 = make2of3();
            const { script, commit } = envelopeFor3(a3);
            const out = await client3(a3).sign({
                psbt: commitPsbt3(a3, commit).toHex(), secretKey: a3.agentSk,
                envelopeScript: script.toString('hex'),
            });
            expect(out.action).to.equal('FILE');
            expect(schnorr.verify(out.signature, out.msg, a3.account.outputXOnly)).to.equal(true);
        });

        it('reveals under the leaf key with NO tweak, not under the account tweak', async function () {
            // The regression this pins: on a reveal the daemon fell through to the
            // ACCOUNT's tweaks on a reveal, which is empty on a 2-of-2 (so the bug
            // was invisible) but is the 2-of-3 key-path tweak here - a signature
            // under a key the leaf's OP_CHECKSIG does not name.
            const a3 = make2of3();
            const { script, commit } = envelopeFor3(a3);
            const psbt = revealPsbt3(a3, commit);
            const out = await client3(a3).sign({
                psbt: psbt.toHex(), secretKey: a3.agentSk, envelopeScript: script.toString('hex'),
            });
            const expectedMsg = envelopeScriptPathSighash(
                bitcoin.Psbt.fromHex(psbt.toHex()), 0, undefined, commit.leafHash);
            expect(Buffer.from(out.msg).equals(expectedMsg)).to.equal(true);
            expect(schnorr.verify(out.signature, out.msg, a3.account.internalXOnly)).to.equal(true);
            // ... and emphatically NOT under the account's tweaked output key.
            expect(schnorr.verify(out.signature, out.msg, a3.account.outputXOnly)).to.equal(false);
        });

        it('cancels under the commit output key, tweaked by the three-leaf root', async function () {
            const a3 = make2of3();
            const { script, commit } = envelopeFor3(a3);
            const out = await client3(a3).sign({
                psbt: cancelPsbt3(a3, commit).toHex(), secretKey: a3.agentSk,
                envelopeScript: script.toString('hex'),
            });
            expect(schnorr.verify(out.signature, out.msg, commit.outputXOnly)).to.equal(true);
        });

        it('names the round it approved, same as on a 2-of-2', function () {
            const a3 = make2of3();
            const { script, commit } = envelopeFor3(a3);
            const nonce = () => Buffer.from(new MuSig2().generateNonce(
                { publicKey: a3.agentPk, secretKey: a3.agentSk })).toString('hex');
            const ask = (psbt) => a3.co.process({ psbt: psbt.toHex(),
                envelope: { script: script.toString('hex') },
                inputs: [{ index: 0, agentPublicNonce: nonce() }] });
            expect(ask(commitPsbt3(a3, commit)).envelopeRole).to.equal('commit');
            expect(ask(revealPsbt3(a3, commit)).envelopeRole).to.equal('reveal');
            expect(ask(cancelPsbt3(a3, commit)).envelopeRole).to.equal('cancel');
        });
    });
});
