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
const { inProcessTransport, httpTransport } = CoSignerClient;
const { deriveMuSig2P2TR } = require('../../src/cosigner/account.js');

describe('httpTransport (sidecar fault diagnosability)', function () {
    it('maps a non-2xx proxy response to a tagged COSIGNER_TRANSPORT_ERROR', async function () {
        const fakeFetch = async () => ({ ok: false, status: 502, json: async () => { throw new Error('should not be read'); } });
        const t = httpTransport('http://127.0.0.1:9/cosign', { fetch: fakeFetch });
        let err;
        try { await t({ psbt: 'deadbeef' }); } catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.code).to.equal('COSIGNER_TRANSPORT_ERROR');
        expect(err.message).to.contain('502');
    });

    it('wraps an unparseable (non-JSON) 2xx body as COSIGNER_TRANSPORT_ERROR', async function () {
        const fakeFetch = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } });
        const t = httpTransport('http://127.0.0.1:9/cosign', { fetch: fakeFetch });
        let err;
        try { await t({ psbt: 'deadbeef' }); } catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.code).to.equal('COSIGNER_TRANSPORT_ERROR');
    });

    it('returns the parsed body unchanged on a normal 2xx JSON response', async function () {
        const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({ approved: true, sig: 'ab' }) });
        const t = httpTransport('http://127.0.0.1:9/cosign', { fetch: fakeFetch });
        const res = await t({ psbt: 'deadbeef' });
        expect(res.approved).to.equal(true);
        expect(res.sig).to.equal('ab');
    });
});

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

    it('rejects a signer set larger than the pair it can actually sign for', function () {
        // sign()/signAll() aggregate exactly two partials, so a three-key set would
        // derive and fund an aggregate address this client can never spend.
        const key = () => Buffer.from(secp256k1.getPublicKey(crypto.randomBytes(32), true));
        const three = [key(), key(), key()];
        expect(() => new CoSignerClient({ transport: () => {}, publicKeys: three })).to.throw(/exactly the \[agent, daemon\]/);
        expect(() => new CoSigner({ secretKey: crypto.randomBytes(32), publicKeys: three, policy: { allowedActions: new Set(['SEND']) } }))
            .to.throw(/exactly the \[agent, daemon\]/);
    });

    // The client must bind the co-signer's returned msg to the PSBT it actually
    // submitted (recomputed BIP341 key-path sighash), so a buggy/misconfigured
    // co-signer fails loudly here instead of yielding a wrong-message signature
    // that dies later as an opaque network rejection.
    describe('msg-to-PSBT binding', function () {

        // Wrap the in-process transport and tamper the returned msg(s).
        function tamperedTransport(co, mutate) {
            const real = inProcessTransport(co);
            return async (body) => mutate(await real(body));
        }

        it('sign() throws COSIGNER_MSG_MISMATCH before signing when the returned msg is not the PSBT sighash', async function () {
            const s = setup('SEND|0|TOK|5|1destX|m');
            const co = new CoSigner({ secretKey: s.coSk, publicKeys: s.keys, tweaks: s.acct.tweaks,
                policy: { allowedActions: new Set(['SEND']) } });
            const client = new CoSignerClient({
                transport: tamperedTransport(co, (res) => {
                    // One wire result shape now: tamper inside the signatures array.
                    if (res.approved) res.signatures[0].msg = crypto.randomBytes(32).toString('hex');
                    return res;
                }),
                publicKeys: s.keys, tweaks: s.acct.tweaks });

            let err;
            try { await client.sign({ psbt: s.psbtHex, secretKey: s.agentSk }); }
            catch (e) { err = e; }
            expect(err).to.exist;
            expect(err.code).to.equal('COSIGNER_MSG_MISMATCH');
        });

        it('signAll() throws COSIGNER_MSG_MISMATCH when any returned msg is not that input\'s PSBT sighash', async function () {
            const s = setup('SEND|0|TOK|5|1destX|m');
            const co = new CoSigner({ secretKey: s.coSk, publicKeys: s.keys, tweaks: s.acct.tweaks,
                policy: { allowedActions: new Set(['SEND']) } });
            const client = new CoSignerClient({
                transport: tamperedTransport(co, (res) => {
                    if (res.approved && Array.isArray(res.signatures))
                        res.signatures[0].msg = crypto.randomBytes(32).toString('hex');
                    return res;
                }),
                publicKeys: s.keys, tweaks: s.acct.tweaks });

            let err;
            try { await client.signAll({ psbt: s.psbtHex, secretKey: s.agentSk, inputIndexes: [0] }); }
            catch (e) { err = e; }
            expect(err).to.exist;
            expect(err.code).to.equal('COSIGNER_MSG_MISMATCH');
        });

        it('signAll() still succeeds when the returned msgs match the submitted PSBT', async function () {
            const s = setup('SEND|0|TOK|5|1destX|m');
            const co = new CoSigner({ secretKey: s.coSk, publicKeys: s.keys, tweaks: s.acct.tweaks,
                policy: { allowedActions: new Set(['SEND']) } });
            const client = new CoSignerClient({ transport: inProcessTransport(co), publicKeys: s.keys, tweaks: s.acct.tweaks });

            const out = await client.signAll({ psbt: s.psbtHex, secretKey: s.agentSk, inputIndexes: [0] });
            expect(out.signatures).to.have.length(1);
            expect(schnorr.verify(out.signatures[0].signature, out.signatures[0].msg, s.acct.aggregateXOnly)).to.equal(true);
        });
    });
});
