// Copyright 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const {
    expect, crypto, bitcoin, MuSig2, deriveEnvelopeCommit, makeAccount,
    buildEnvelopeScript, buildRevealPsbt, makeCoSigner,
} = require('./helpers/support.js');
const { decodeActionFromPsbt, decodeEnvelopeAction } =
    require('../../../../src/cosigner/psbt_action_decode.js');

function request(acct, co, psbt, script) {
    const nonce = new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk });
    return co.process({
        psbt: psbt.toHex(),
        envelope: { script: script.toString('hex') },
        inputs: [{ index: 0, agentPublicNonce: Buffer.from(nonce).toString('hex') }],
    });
}

describe('co-signer envelope size and cancel output guards', function () {
    it('decodes a known envelope action above the inline size ceiling', function () {
        const acct = makeAccount();
        const action = 'BROADCAST|0|' + 'm'.repeat(9000);
        const script = buildEnvelopeScript(acct.aggKey, action, null);
        const commit = deriveEnvelopeCommit({ internalXOnly: acct.aggKey, envelopeScript: script });
        const direct = decodeEnvelopeAction(script);
        const reveal = decodeActionFromPsbt(buildRevealPsbt(acct, commit));
        expect(direct.ok).to.equal(true);
        expect(direct.actionString).to.equal(action);
        expect(reveal.ok).to.equal(true);
        expect(reveal.actionString).to.equal(action);
    });

    it('refuses a cancel payment even when its destination is allow-listed', function () {
        const acct = makeAccount();
        const action = 'FILE|0|report.bin|application/octet-stream';
        const script = buildEnvelopeScript(acct.aggKey, action, null);
        const commit = deriveEnvelopeCommit({ internalXOnly: acct.aggKey, envelopeScript: script });
        const foreign = bitcoin.payments.p2tr({ pubkey: makeAccount().aggKey }).output;
        const co = makeCoSigner(acct, { allowedOutputs: [{ script: foreign, maxValue: 20000 }] });
        const psbt = new bitcoin.Psbt();
        psbt.addInput({ hash: crypto.randomBytes(32), index: 0,
            witnessUtxo: { script: commit.output, value: 20000 },
            tapInternalKey: acct.aggKey, tapMerkleRoot: commit.merkleRoot });
        psbt.addOutput({ script: foreign, value: 15000 });
        const out = request(acct, co, psbt, script);
        expect(out.approved).to.equal(false);
        expect(out.reason).to.equal('UNAUTHORIZED_OUTPUT');
    });
});
