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

function request(acct, co, psbt, scriptHex) {
    return co.process({
        psbt: psbt.toHex(),
        envelope: scriptHex ? { script: scriptHex } : undefined,
        inputs: [{ index: 0, agentPublicNonce: Buffer.from(
            new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk })).toString('hex') }],
    });
}

describe('co-signer: Taproot envelope composition', function () {

    describe('refusals that keep the shipped guarantees', function () {
        it('refuses an envelope script that is not the §3.2 grammar', function () {
            const acct = makeAccount();
            const { commit } = commitFor(acct);
            const co = makeCoSigner(acct);
            const out = request(acct, co, buildCommitPsbt(acct, commit), crypto.randomBytes(40).toString('hex'));
            expect(out.reason).to.equal('ENVELOPE_SCRIPT_INVALID');
        });

        it('refuses an envelope the transaction neither funds nor spends', function () {
            const acct = makeAccount();
            const { script } = commitFor(acct);
            const other = commitFor(acct);
            const co = makeCoSigner(acct);
            // A PSBT funding a DIFFERENT envelope than the script declares.
            const out = request(acct, co, buildCommitPsbt(acct, other.commit), script.toString('hex'));
            expect(out.reason).to.equal('ENVELOPE_NOT_COMMITTED');
        });

        it('refuses an envelope leaf keyed on the account OUTPUT key instead of the cooperative aggregate', function () {
            // The plausible wrong choice on a 2-of-3: its account output key is
            // tap-tweaked, and a leaf keyed on it could never be co-signed as a
            // no-tweak reveal. The daemon must refuse rather than sign under it.
            const a3 = make2of3();
            const script = buildEnvelopeScript(a3.co.aggregateXOnly, ACTION, crypto.randomBytes(100));
            const commit = deriveEnvelopeCommit({
                internalXOnly: a3.co.aggregateXOnly, envelopeScript: script,
            });
            const out = a3.co.process({
                psbt: commitPsbt3(a3, commit).toHex(),
                envelope: { script: script.toString('hex') },
                inputs: [{ index: 0, agentPublicNonce: Buffer.from(
                    new MuSig2().generateNonce({ publicKey: a3.agentPk, secretKey: a3.agentSk })).toString('hex') }],
            });
            expect(out.approved).to.equal(false);
            expect(out.reason).to.equal('ENVELOPE_SCRIPT_INVALID');
        });
    });
});

describe('co-signer: Taproot envelope composition', function () {

    describe('refusals that keep the shipped guarantees', function () {
        it('refuses a reveal whose output drains somewhere other than the account', function () {
            const acct = makeAccount();
            const { script, commit } = commitFor(acct);
            const co = makeCoSigner(acct);
            const foreign = bitcoin.payments.p2tr({ pubkey: makeAccount().aggKey }).output;
            const psbt = buildRevealPsbt(acct, commit, { outputScript: foreign });
            const out = request(acct, co, psbt, script.toString('hex'));
            expect(out.approved).to.equal(false);
            expect(out.reason).to.equal('UNAUTHORIZED_OUTPUT');
        });

        it('refuses an out-of-policy action carried by a perfectly valid envelope', function () {
            const acct = makeAccount();
            const script = buildEnvelopeScript(acct.aggKey,
                'SEND|0|MYTOKEN|10|1destX|m', crypto.randomBytes(100));
            const commit = deriveEnvelopeCommit({ internalXOnly: acct.aggKey, envelopeScript: script });
            const co = makeCoSigner(acct);   // policy allows FILE only
            const out = request(acct, co, buildCommitPsbt(acct, commit), script.toString('hex'));
            expect(out.approved).to.equal(false);
            expect(out.reason).to.not.equal(undefined);
            expect(out.reason).to.not.equal('APPROVED');
        });

        it('leaves ordinary (non-envelope) requests completely unchanged', function () {
            const acct = makeAccount();
            const inner = bitcoin.script.compile([Buffer.from('SEND|0|MYTOKEN|10|1destX|m', 'utf8')]);
            const prevHash = crypto.randomBytes(32);
            const txid = Buffer.from(prevHash).reverse().toString('hex');
            const cipher = crypto.createCipheriv('aes-128-ctr', txid.substr(0, 16), txid.substr(16, 16));
            const obf = Buffer.concat([cipher.update(Buffer.concat([Buffer.from('XCHN'), inner])), cipher.final()]);
            const psbt = new bitcoin.Psbt();
            psbt.addInput({ hash: prevHash, index: 0, witnessUtxo: { script: acct.p2trScript, value: 100000 } });
            psbt.addOutput({ script: bitcoin.payments.embed({ data: [obf] }).output, value: 0 });
            psbt.addOutput({ script: acct.p2trScript, value: 90000 });
            const co = makeCoSigner(acct, { policy: { allowedActions: new Set(['SEND']) } });
            const out = co.process({
                psbt: psbt.toHex(),
                inputs: [{ index: 0, agentPublicNonce: Buffer.from(
                    new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk })).toString('hex') }],
            });
            expect(out.approved).to.equal(true);
            expect(out.envelopeRole).to.equal(undefined);
        });
    });
});
