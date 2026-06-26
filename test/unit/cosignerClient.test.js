// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect } = require('chai');
const crypto  = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const { secp256k1, schnorr } = require('@noble/curves/secp256k1');
const CoSigner = require('../../src/cosigner/coSigner.js');
const CoSignerClient = require('../../src/cosigner/client.js');
const { inProcessTransport } = CoSignerClient;
const { deriveMuSig2P2TR } = require('../../src/cosigner/account.js');

// A 2-of-2 account + a PSBT spending it that carries `actionString` in an
// obfuscated OP_RETURN (built like the encoder).
function setup(actionString) {
    const agentSk = crypto.randomBytes(32), coSk = crypto.randomBytes(32);
    const agentPk = secp256k1.getPublicKey(agentSk, true), coPk = secp256k1.getPublicKey(coSk, true);
    const keys = [agentPk, coPk];
    const acct = deriveMuSig2P2TR(keys);

    const prevHash = crypto.randomBytes(32);
    const txid = Buffer.from(prevHash).reverse().toString('hex');
    const inner = bitcoin.script.compile([Buffer.from(actionString, 'utf8')]);
    const cipher = crypto.createCipheriv('aes-128-ctr', txid.substr(0, 16), txid.substr(16, 16));
    const obf = Buffer.concat([cipher.update(Buffer.concat([Buffer.from('XCHN'), inner])), cipher.final()]);
    const psbt = new bitcoin.Psbt();
    psbt.addInput({ hash: prevHash, index: 0, witnessUtxo: { script: acct.output, value: 100000 } });
    psbt.addOutput({ script: bitcoin.payments.embed({ data: [obf] }).output, value: 0 });
    psbt.addOutput({ script: acct.output, value: 90000 });   // change back to the account

    return { agentSk, coSk, keys, acct, psbtHex: psbt.toHex() };
}

describe('CoSignerClient (agent side)', function () {

    it('runs the full round and returns a valid spend signature on approval', async function () {
        const s = setup('SEND|0|TOK|5|1destX|m');
        const co = new CoSigner({ secretKey: s.coSk, publicKeys: s.keys, tweaks: s.acct.tweaks,
            policy: { allowedActions: new Set(['SEND']) } });
        const client = new CoSignerClient({ transport: inProcessTransport(co), publicKeys: s.keys, tweaks: s.acct.tweaks });

        const out = await client.sign({ psbt: s.psbtHex, secretKey: s.agentSk });
        expect(out.signature).to.have.length(64);
        expect(out.action).to.equal('SEND');
        // The signature is a valid key-path spend of the derived address.
        expect(schnorr.verify(out.signature, out.msg, s.acct.aggregateXOnly)).to.equal(true);
    });

    it('throws SDKPolicyError carrying the co-signer reason on denial', async function () {
        const s = setup('SEND|0|TOK|100|1destX|m');
        const co = new CoSigner({ secretKey: s.coSk, publicKeys: s.keys, tweaks: s.acct.tweaks,
            policy: { allowedActions: new Set(['SEND']), maxPerAction: { SEND: { TOK: '50' } } } });
        const client = new CoSignerClient({ transport: inProcessTransport(co), publicKeys: s.keys, tweaks: s.acct.tweaks });

        let err;
        try { await client.sign({ psbt: s.psbtHex, secretKey: s.agentSk }); }
        catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.code).to.equal('POLICY_AMOUNT_EXCEEDED');
    });

    it('rejects a missing transport / publicKeys at construction', function () {
        expect(() => new CoSignerClient({ publicKeys: [1, 2] })).to.throw(/transport/);
        expect(() => new CoSignerClient({ transport: () => {} })).to.throw(/publicKeys/);
    });
});
