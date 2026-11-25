// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const {
    expect, crypto, bitcoin, MuSig2, makeAccount, commitFor,
    buildCommitPsbt, makeCoSigner, LEAF_VERSION,
} = require('./helpers/support.js');

function request(acct, co, psbt, envelope) {
    const nonce = new MuSig2().generateNonce({
        publicKey: acct.agentPk, secretKey: acct.agentSk,
    });
    return co.process({
        psbt: psbt.toHex(), envelope,
        inputs: [{ index: 0, agentPublicNonce: Buffer.from(nonce).toString('hex') }],
    });
}

function accountSpendWithLeaf(acct, commit, leafIndex) {
    const psbt = new bitcoin.Psbt();
    const inputCount = leafIndex + 1;
    for (let index = 0; index < inputCount; index++) {
        psbt.addInput({
            hash: crypto.randomBytes(32), index: 0,
            witnessUtxo: { script: acct.p2trScript, value: 100000 },
        });
    }
    psbt.updateInput(leafIndex, {
        tapLeafScript: [{
            leafVersion: LEAF_VERSION,
            script: commit.script,
            controlBlock: commit.controlBlock,
        }],
    });
    psbt.addOutput({ script: acct.p2trScript, value: inputCount * 100000 - 10000 });
    return psbt;
}

describe('co-signer envelope metadata context', function () {
    for (const leafIndex of [0, 1]) {
        it('refuses an uncommitted envelope leaf on input ' + leafIndex, function () {
            const acct = makeAccount();
            const { commit } = commitFor(acct);
            const out = request(acct, makeCoSigner(acct),
                accountSpendWithLeaf(acct, commit, leafIndex));
            expect(out.approved).to.equal(false);
            expect(out.reason).to.equal('ENVELOPE_CONTEXT_MISSING');
            expect(out.detail.index).to.equal(leafIndex);
        });
    }

    it('refuses leaf metadata on an envelope commit input', function () {
        const acct = makeAccount();
        const { script, commit } = commitFor(acct);
        const psbt = buildCommitPsbt(acct, commit);
        psbt.updateInput(0, {
            tapLeafScript: [{
                leafVersion: LEAF_VERSION,
                script: commit.script,
                controlBlock: commit.controlBlock,
            }],
        });
        const out = request(acct, makeCoSigner(acct), psbt,
            { script: script.toString('hex') });
        expect(out.approved).to.equal(false);
        expect(out.reason).to.equal('ENVELOPE_LEAF_UNEXPECTED');
        expect(out.detail.role).to.equal('commit');
    });
});
