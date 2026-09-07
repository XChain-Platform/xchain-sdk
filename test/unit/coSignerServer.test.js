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
const http    = require('http');
const crypto  = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const { secp256k1 } = require('@noble/curves/secp256k1');
const MuSig2 = require('../../src/musig2.js');
const CoSigner = require('../../src/cosigner/coSigner.js');
const { createCoSignerApp } = require('../../src/cosigner/server.js');

// Minimal JSON POST over real HTTP (no supertest dependency).
function post(port, path, body, headers) {
    return new Promise((resolve, reject) => {
        const data = Buffer.from(JSON.stringify(body));
        const req = http.request({ host: '127.0.0.1', port, path, method: 'POST',
            headers: Object.assign({ 'content-type': 'application/json', 'content-length': data.length }, headers || {}) },
            (res) => {
                let chunks = '';
                res.on('data', (c) => { chunks += c; });
                res.on('end', () => resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }));
            });
        req.on('error', reject);
        req.write(data); req.end();
    });
}

describe('co-signer HTTP sidecar', function () {
    let server, port, acct, agentNonce, psbtHex;

    before(function (done) {
        // A 2-of-2 account + a signable in-policy PSBT.
        const agentSk = crypto.randomBytes(32), coSk = crypto.randomBytes(32);
        const agentPk = secp256k1.getPublicKey(agentSk, true), coPk = secp256k1.getPublicKey(coSk, true);
        const keys = [agentPk, coPk];
        const aggXOnly = Buffer.from(new MuSig2().aggregateKeys(keys).xOnlyPubkey);
        const p2tr = bitcoin.payments.p2tr({ pubkey: aggXOnly });

        const prevHash = crypto.randomBytes(32);
        const txid = Buffer.from(prevHash).reverse().toString('hex');
        const inner = bitcoin.script.compile([Buffer.from('SEND|0|TOK|1|1destX|m', 'utf8')]);
        const cipher = crypto.createCipheriv('aes-128-ctr', txid.substr(0, 16), txid.substr(16, 16));
        const obf = Buffer.concat([cipher.update(Buffer.concat([Buffer.from('XCHN'), inner])), cipher.final()]);
        const psbt = new bitcoin.Psbt();
        psbt.addInput({ hash: prevHash, index: 0, witnessUtxo: { script: p2tr.output, value: 100000 } });
        psbt.addOutput({ script: bitcoin.payments.embed({ data: [obf] }).output, value: 0 });
        psbt.addOutput({ script: p2tr.output, value: 90000 });   // change back to the account
        psbtHex = psbt.toHex();
        agentNonce = Buffer.from(new MuSig2().generateNonce({ publicKey: agentPk, secretKey: agentSk })).toString('hex');

        const co = new CoSigner({ secretKey: coSk, publicKeys: keys, policy: { allowedActions: new Set(['SEND']) } });
        const app = createCoSignerApp(co, { token: 'sekret' });
        server = app.listen(0, '127.0.0.1', () => { port = server.address().port; done(); });
    });

    after(function (done) { server.close(done); });

    it('rejects construction without a CoSigner', function () {
        expect(() => createCoSignerApp(null)).to.throw(/requires a CoSigner/);
    });

    it('rejects construction with no token (fail-closed) unless allowUnauthenticated', function () {
        const sk = crypto.randomBytes(32);
        const pk = secp256k1.getPublicKey(sk, true);
        // Two DISTINCT participants: CoSigner now rejects a repeated key, so a
        // [pk, pk] fixture never reaches the token gate this test is about.
        const otherPk = secp256k1.getPublicKey(crypto.randomBytes(32), true);
        const co = new CoSigner({ secretKey: sk, publicKeys: [pk, otherPk], policy: { allowedActions: new Set(['SEND']) } });
        expect(() => createCoSignerApp(co)).to.throw(/requires a non-empty opts\.token/);
        expect(() => createCoSignerApp(co, { token: '' })).to.throw(/requires a non-empty opts\.token/);
        // Explicit escape hatch builds the (unauthenticated) app without throwing.
        expect(() => createCoSignerApp(co, { allowUnauthenticated: true })).to.not.throw();
    });

    it('401s without the bearer token', async function () {
        const r = await post(port, '/cosign', { psbt: psbtHex, inputs: [{ index: 0, agentPublicNonce: agentNonce }] });
        expect(r.status).to.equal(401);
        expect(r.body.reason).to.equal('UNAUTHORIZED');
    });

    it('400s on a malformed request', async function () {
        const r = await post(port, '/cosign', { psbt: 123 }, { authorization: 'Bearer sekret' });
        expect(r.status).to.equal(400);
        expect(r.body.reason).to.equal('BAD_REQUEST');
    });

    it('200 + approved:true for an authorized in-policy request', async function () {
        const r = await post(port, '/cosign', { psbt: psbtHex, inputs: [{ index: 0, agentPublicNonce: agentNonce }] }, { authorization: 'Bearer sekret' });
        expect(r.status).to.equal(200);
        expect(r.body.approved).to.equal(true);
        // ONE response shape since the wire collapse: always a signatures array,
        // even for a single input.
        expect(r.body.signatures).to.have.length(1);
        expect(r.body.signatures[0].sig).to.be.a('string');
        expect(r.body.signatures[0].publicNonce).to.be.a('string');
    });

    it('401s on a wrong token of the SAME length as the real one', async function () {
        const wrong = 'sekret'.split('').reverse().join('');
        expect(wrong.length).to.equal('sekret'.length);
        const r = await post(port, '/cosign', { psbt: psbtHex, inputs: [{ index: 0, agentPublicNonce: agentNonce }] }, { authorization: 'Bearer ' + wrong });
        expect(r.status).to.equal(401);
        expect(r.body.reason).to.equal('UNAUTHORIZED');
    });

    it('401s on a wrong token of a DIFFERENT length', async function () {
        const r = await post(port, '/cosign', { psbt: psbtHex, inputs: [{ index: 0, agentPublicNonce: agentNonce }] }, { authorization: 'Bearer short' });
        expect(r.status).to.equal(401);
        expect(r.body.reason).to.equal('UNAUTHORIZED');
    });

    it('401s on a malformed authorization header (no Bearer prefix)', async function () {
        const r = await post(port, '/cosign', { psbt: psbtHex, inputs: [{ index: 0, agentPublicNonce: agentNonce }] }, { authorization: 'sekret' });
        expect(r.status).to.equal(401);
        expect(r.body.reason).to.equal('UNAUTHORIZED');
    });

    it('401s on a non-Bearer scheme', async function () {
        const r = await post(port, '/cosign', { psbt: psbtHex, inputs: [{ index: 0, agentPublicNonce: agentNonce }] }, { authorization: 'Basic sekret' });
        expect(r.status).to.equal(401);
        expect(r.body.reason).to.equal('UNAUTHORIZED');
    });

    // The body cap must not be a hardcoded 256kb, roughly a sixth of the largest
    // envelope round the protocol permits: under such a cap an oversize body
    // reaches Express's default HTML error page, which httpTransport reads as
    // COSIGNER_TRANSPORT_ERROR, "dead sidecar, or a proxy error page". These
    // pin both halves: the ceiling covers a real envelope round, and anything
    // past whatever ceiling is configured is NAMED.
    describe('request-body ceiling', function () {

        it('accepts a body far larger than the old 256kb cap', async function () {
            // ~600 KB of envelope script hex: over the old limit, under the new
            // default. It must reach the handler and be JUDGED (a policy denial
            // is a 200 here), not rejected by the transport.
            const r = await post(port, '/cosign', {
                psbt: psbtHex,
                inputs: [{ index: 0, agentPublicNonce: agentNonce }],
                envelope: { script: 'ab'.repeat(300000) },
            }, { authorization: 'Bearer sekret' });
            expect(r.status).to.equal(200);
            expect(r.body).to.have.property('approved');
        });

        it('names an oversize body instead of answering an HTML error page', async function () {
            // The daemon's own key sits in the pair it is configured with (the
            // constructor refuses a set its secretKey does not appear in).
            const daemonSk = crypto.randomBytes(32);
            const co = new CoSigner({ secretKey: daemonSk,
                publicKeys: [secp256k1.getPublicKey(crypto.randomBytes(32), true),
                    secp256k1.getPublicKey(daemonSk, true)],
                policy: { allowedActions: new Set(['SEND']) } });
            const logs = [];
            const app = createCoSignerApp(co, { token: 'sekret', maxBodyBytes: 4096,
                logger: (...a) => logs.push(a) });
            const srv = app.listen(0, '127.0.0.1');
            await new Promise((r) => srv.once('listening', r));
            try {
                const r = await post(srv.address().port, '/cosign',
                    { psbt: 'aa'.repeat(8000), inputs: [{ index: 0, agentPublicNonce: 'bb' }] },
                    { authorization: 'Bearer sekret' });
                expect(r.status).to.equal(413);
                expect(r.body.reason).to.equal('REQUEST_TOO_LARGE');
                expect(r.body.approved).to.equal(false);
                expect(r.body.detail).to.be.a('string').and.contain('4096');
                expect(logs.some((l) => l[0] === 'warn')).to.equal(true);
            } finally { await new Promise((r) => srv.close(r)); }
        });

        it('leaves every other parse failure on the path it already had', async function () {
            // The oversize handler must not swallow malformed JSON: that still
            // lands on Express's own 400, not on a 413 REQUEST_TOO_LARGE.
            const status = await new Promise((resolve, reject) => {
                const data = Buffer.from('{"psbt": ');
                const req = http.request({ host: '127.0.0.1', port, path: '/cosign', method: 'POST',
                    headers: { 'content-type': 'application/json', 'content-length': data.length,
                        authorization: 'Bearer sekret' } },
                    (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
                req.on('error', reject);
                req.write(data); req.end();
            });
            expect(status).to.equal(400);
        });

        it('rejects a nonsensical maxBodyBytes at construction', function () {
            // The daemon's own key sits in the pair it is configured with (the
            // constructor refuses a set its secretKey does not appear in).
            const daemonSk = crypto.randomBytes(32);
            const co = new CoSigner({ secretKey: daemonSk,
                publicKeys: [secp256k1.getPublicKey(crypto.randomBytes(32), true),
                    secp256k1.getPublicKey(daemonSk, true)],
                policy: { allowedActions: new Set(['SEND']) } });
            expect(() => createCoSignerApp(co, { token: 't', maxBodyBytes: 0 })).to.throw(/maxBodyBytes/);
            expect(() => createCoSignerApp(co, { token: 't', maxBodyBytes: 1.5 })).to.throw(/maxBodyBytes/);
        });

        it('reaches the agent as REQUEST_TOO_LARGE, not COSIGNER_TRANSPORT_ERROR', async function () {
            // The whole point of naming it: httpTransport prefers a JSON
            // `reason` over the transport error (G13), so no client change is
            // needed - but only if the server answers JSON at all.
            const { httpTransport } = require('../../src/cosigner/client.js');
            // The daemon's own key sits in the pair it is configured with (the
            // constructor refuses a set its secretKey does not appear in).
            const daemonSk = crypto.randomBytes(32);
            const co = new CoSigner({ secretKey: daemonSk,
                publicKeys: [secp256k1.getPublicKey(crypto.randomBytes(32), true),
                    secp256k1.getPublicKey(daemonSk, true)],
                policy: { allowedActions: new Set(['SEND']) } });
            const app = createCoSignerApp(co, { token: 'sekret', maxBodyBytes: 4096, logger: () => {} });
            const srv = app.listen(0, '127.0.0.1');
            await new Promise((r) => srv.once('listening', r));
            try {
                const transport = httpTransport(
                    'http://127.0.0.1:' + srv.address().port + '/cosign', { token: 'sekret' });
                let err;
                try {
                    await transport({ psbt: 'aa'.repeat(8000), inputs: [{ index: 0, agentPublicNonce: 'bb' }] });
                } catch (e) { err = e; }
                expect(err, 'an oversize body must reject').to.exist;
                expect(err.code).to.equal('REQUEST_TOO_LARGE');
                expect(err.code).to.not.equal('COSIGNER_TRANSPORT_ERROR');
            } finally { await new Promise((r) => srv.close(r)); }
        });

        it('the default ceiling covers a maximum protocol envelope round', function () {
            // The derivation, not the literal: the payload rides the wire twice,
            // both times hex-encoded, so anything less is unservable by design.
            const { DEFAULT_MAX_BODY_BYTES, ENVELOPE_WIRE_BYTES } =
                require('../../src/cosigner/httpBodyLimit.js');
            const { ENVELOPE_MAX_PAYLOAD } = require('../../src/protocol/constants.js');
            expect(ENVELOPE_WIRE_BYTES).to.equal(4 * ENVELOPE_MAX_PAYLOAD);
            expect(DEFAULT_MAX_BODY_BYTES).to.be.greaterThan(ENVELOPE_WIRE_BYTES);
        });
    });
});
