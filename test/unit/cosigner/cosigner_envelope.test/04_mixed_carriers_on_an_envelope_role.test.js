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

    // An envelope carries its action in the LEAF, so the transaction needs no data
    // carrier at all. A zero-value OP_RETURN on a commit is therefore a second,
    // unjudged action riding on a signature the daemon gave to the leaf's action:
    // policy sees the declared FILE, the chain executes the SEND, and the co-signer's
    // window never records it. A cancel is sharper still, because it is not
    // policy-judged at all.
// The encoder's own inline carrier construction: XCHN magic + a compiled push
// of the action bytes, AES-128-CTR obfuscated under the first input's txid.
function carrierOutput(prevHash, actionString) {
    const txid = Buffer.from(prevHash).reverse().toString('hex');
    const tagged = Buffer.concat([Buffer.from('XCHN'),
        bitcoin.script.compile([Buffer.from(actionString, 'utf8')])]);
    const cipher = crypto.createCipheriv('aes-128-ctr', txid.substr(0, 16), txid.substr(16, 16));
    const obf = Buffer.concat([cipher.update(tagged), cipher.final()]);
    return bitcoin.payments.embed({ data: [obf] }).output;
}

function ask(acct, co, psbt, script) {
    return co.process({
        psbt: psbt.toHex(),
        envelope: script ? { script: script.toString('hex') } : undefined,
        inputs: [{ index: 0, agentPublicNonce: Buffer.from(
            new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk })).toString('hex') }],
    });
}

// A commit funding transaction with an extra SEND carrier smuggled in.
function smuggledCommit(acct, commit, opts = {}) {
    const prevHash = crypto.randomBytes(32);
    const psbt = new bitcoin.Psbt();
    psbt.addInput({ hash: prevHash, index: 0,
        witnessUtxo: { script: acct.p2trScript, value: 100000 } });
    psbt.addOutput({ script: commit.output, value: 20000 });
    psbt.addOutput({
        script: opts.decoy
            ? bitcoin.payments.embed({ data: [Buffer.from('not an xchain carrier')] }).output
            : carrierOutput(prevHash, 'SEND|0|TOK|1000|1attackerDest|m'),
        value: 0,
    });
    psbt.addOutput({ script: acct.p2trScript, value: 70000 });
    return psbt;
}

describe('co-signer: Taproot envelope composition', function () {

    describe('mixed carriers on an envelope role', function () {
        it('refuses a commit that also carries an OP_RETURN action', function () {
            const acct = makeAccount();
            const { script, commit } = commitFor(acct);
            const out = ask(acct, makeCoSigner(acct), smuggledCommit(acct, commit), script);
            expect(out.approved).to.equal(false);
            expect(out.reason).to.equal('ENVELOPE_MIXED_CARRIER');
            expect(out.signatures).to.equal(undefined);
        });

        it('refuses a decoy OP_RETURN too, without decoding its payload', function () {
            const acct = makeAccount();
            const { script, commit } = commitFor(acct);
            const out = ask(acct, makeCoSigner(acct), smuggledCommit(acct, commit, { decoy: true }), script);
            expect(out.approved).to.equal(false);
            expect(out.reason).to.equal('ENVELOPE_MIXED_CARRIER');
        });

        it('refuses a CANCEL that carries one, which policy never looks at', function () {
            const acct = makeAccount();
            const { script, commit } = commitFor(acct);
            const prevHash = crypto.randomBytes(32);
            const psbt = new bitcoin.Psbt();
            psbt.addInput({ hash: prevHash, index: 0,
                witnessUtxo: { script: commit.output, value: 20000 },
                tapInternalKey: acct.aggKey, tapMerkleRoot: commit.merkleRoot });
            psbt.addOutput({ script: carrierOutput(prevHash, 'SEND|0|TOK|1000|1attackerDest|m'), value: 0 });
            psbt.addOutput({ script: acct.p2trScript, value: 15000 });
            const out = ask(acct, makeCoSigner(acct), psbt, script);
            expect(out.approved).to.equal(false);
            expect(out.reason).to.equal('ENVELOPE_MIXED_CARRIER');
        });
    });
});

describe('co-signer: Taproot envelope composition', function () {

    describe('mixed carriers on an envelope role', function () {
        // The other arm of the same branch, unchanged: OFF an envelope role the
        // zero-value OP_RETURN is the action carrier and must still be exempt. This
        // pair is the control for the refusals above - identical carrier output,
        // opposite verdict, and the only difference is the envelope role.
        it('still approves the ordinary inline carrier on a non-envelope spend', function () {
            const acct = makeAccount();
            const prevHash = crypto.randomBytes(32);
            const psbt = new bitcoin.Psbt();
            psbt.addInput({ hash: prevHash, index: 0,
                witnessUtxo: { script: acct.p2trScript, value: 100000 } });
            psbt.addOutput({ script: carrierOutput(prevHash, ACTION), value: 0 });
            psbt.addOutput({ script: acct.p2trScript, value: 90000 });
            const out = ask(acct, makeCoSigner(acct), psbt, null);
            expect(out.approved).to.equal(true);
            expect(out.action).to.equal('FILE');
        });

        it('still denies a non-envelope OP_RETURN that carries value', function () {
            const acct = makeAccount();
            const prevHash = crypto.randomBytes(32);
            const psbt = new bitcoin.Psbt();
            psbt.addInput({ hash: prevHash, index: 0,
                witnessUtxo: { script: acct.p2trScript, value: 100000 } });
            psbt.addOutput({ script: carrierOutput(prevHash, ACTION), value: 1000 });
            psbt.addOutput({ script: acct.p2trScript, value: 90000 });
            const out = ask(acct, makeCoSigner(acct), psbt, null);
            expect(out.approved).to.equal(false);
            expect(out.reason).to.equal('OP_RETURN_CARRIES_VALUE');
        });
    });
});
