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
// The hosted (multi-tenant) co-signer. Everything here is about the three
// things multi-tenancy changes versus the loopback sidecar: tenant isolation,
// transport security, and an explicit wire version - plus the two gates that
// stop being hardening and become prerequisites (G5's per-tenant window store,
// G14's input cap).

const { expect } = require('chai');
const http    = require('http');
const crypto  = require('crypto');
require('../../src/applyBufferutilsPatch.js');
const bitcoin = require('bitcoinjs-lib');
const { secp256k1 } = require('@noble/curves/secp256k1');
const MuSig2   = require('../../src/musig2.js');
const CoSigner = require('../../src/cosigner/coSigner.js');
const { createHostedCoSignerApp } = require('../../src/cosigner/hostedServer.js');

function makeAccount() {
    const musig   = new MuSig2();
    const agentSk = crypto.randomBytes(32);
    const coSk    = crypto.randomBytes(32);
    const agentPk = secp256k1.getPublicKey(agentSk, true);
    const coPk    = secp256k1.getPublicKey(coSk, true);
    const keys    = [agentPk, coPk];
    const bare    = musig.aggregateKeys(keys);
    const p2tr    = bitcoin.payments.p2tr({ pubkey: Buffer.from(bare.xOnlyPubkey) });
    return { agentSk, coSk, agentPk, coPk, keys, p2trScript: p2tr.output };
}

function buildPsbt(acct, actionString) {
    const prevHash = crypto.randomBytes(32);
    const txid   = Buffer.from(prevHash).reverse().toString('hex');
    const inner  = bitcoin.script.compile([Buffer.from(actionString, 'utf8')]);
    const cipher = crypto.createCipheriv('aes-128-ctr', txid.substr(0, 16), txid.substr(16, 16));
    const obf    = Buffer.concat([cipher.update(Buffer.concat([Buffer.from('XCHN'), inner])), cipher.final()]);
    const psbt = new bitcoin.Psbt();
    psbt.addInput({ hash: prevHash, index: 0, witnessUtxo: { script: acct.p2trScript, value: 100000 } });
    psbt.addOutput({ script: bitcoin.payments.embed({ data: [obf] }).output, value: 0 });
    psbt.addOutput({ script: acct.p2trScript, value: 90000 });
    return psbt;
}

function nonce(acct) {
    return Buffer.from(new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk })).toString('hex');
}

function tenantFor(acct, extra = {}) {
    return new CoSigner(Object.assign({
        secretKey: acct.coSk, publicKeys: acct.keys,
        policy: { allowedActions: new Set(['SEND']) },
    }, extra));
}

const TOKEN_A = 'tenant-a-token-0123456789abcdef';
const TOKEN_B = 'tenant-b-token-0123456789abcdef';

function post(port, body, headers, path = '/v1/cosign') {
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

describe('hosted co-signer: construction prerequisites', function () {

    it('refuses two tenants sharing one window store', function () {
        // Not a tidiness rule. Two tenants writing one store alternately erase
        // each other's consumption history and silently re-open both budgets,
        // and the store's own file lock cannot catch it because both live in ONE
        // process where one of them legitimately holds the lock.
        const a = makeAccount(), b = makeAccount();
        const shared = { snapshot: () => ({ count: 0, perTick: {} }), record: () => {} };
        const policy = { allowedActions: new Set(['SEND']), maxPerWindow: { hours: 24, maxActions: 5 } };
        expect(() => createHostedCoSignerApp({ tenants: [
            { id: 'a', token: TOKEN_A, coSigner: tenantFor(a, { policy, windowStore: shared }) },
            { id: 'b', token: TOKEN_B, coSigner: tenantFor(b, { policy, windowStore: shared }) },
        ] })).to.throw(/shares a window store/);
    });

    it('refuses a tenant with no input cap', function () {
        const a = makeAccount();
        const co = tenantFor(a);
        co.maxCosignInputs = null;          // simulate an unbuilt//disabled cap
        expect(() => createHostedCoSignerApp({ tenants: [{ id: 'a', token: TOKEN_A, coSigner: co }] }))
            .to.throw(/maxCosignInputs/);
    });

    it('refuses a weak or duplicated tenant token', function () {
        const a = makeAccount(), b = makeAccount();
        expect(() => createHostedCoSignerApp({ tenants: [{ id: 'a', token: 'short', coSigner: tenantFor(a) }] }))
            .to.throw(/at least 16 characters/);
        expect(() => createHostedCoSignerApp({ tenants: [
            { id: 'a', token: TOKEN_A, coSigner: tenantFor(a) },
            { id: 'b', token: TOKEN_A, coSigner: tenantFor(b) },
        ] })).to.throw(/share a bearer token/);
    });

    it('refuses duplicate tenant ids and an empty tenant set', function () {
        const a = makeAccount(), b = makeAccount();
        expect(() => createHostedCoSignerApp({ tenants: [] })).to.throw(/non-empty tenants/);
        expect(() => createHostedCoSignerApp({ tenants: [
            { id: 'same', token: TOKEN_A, coSigner: tenantFor(a) },
            { id: 'same', token: TOKEN_B, coSigner: tenantFor(b) },
        ] })).to.throw(/duplicate tenant id/);
    });
});

describe('hosted co-signer: transport', function () {

    it('refuses to bind a non-loopback host without TLS', function () {
        // Loopback made cleartext survivable; a network listener does not. The
        // bearer token IS spending authority.
        const a = makeAccount();
        const app = createHostedCoSignerApp({ tenants: [{ id: 'a', token: TOKEN_A, coSigner: tenantFor(a) }] });
        expect(() => app.listenSecure({ port: 0, host: '0.0.0.0' })).to.throw(/without TLS/);
    });

    it('allows loopback without TLS, for a fronted deployment', function (done) {
        const a = makeAccount();
        const app = createHostedCoSignerApp({ tenants: [{ id: 'a', token: TOKEN_A, coSigner: tenantFor(a) }] });
        const server = app.listenSecure({ port: 0, host: '127.0.0.1', onListening: () => {
            server.close(done);
        } });
    });

    it('rejects a TLS config missing half its material', function () {
        const a = makeAccount();
        const app = createHostedCoSignerApp({ tenants: [{ id: 'a', token: TOKEN_A, coSigner: tenantFor(a) }] });
        expect(() => app.listenSecure({ port: 0, host: '10.0.0.5', tls: { cert: 'x' } })).to.throw(/key and cert/);
    });
});

describe('hosted co-signer: request handling', function () {

    let server, port, acctA, acctB, logs;

    beforeEach(function (done) {
        acctA = makeAccount(); acctB = makeAccount();
        logs = [];
        const app = createHostedCoSignerApp({
            tenants: [
                { id: 'alpha', token: TOKEN_A, coSigner: tenantFor(acctA) },
                { id: 'beta',  token: TOKEN_B, coSigner: tenantFor(acctB) },
            ],
            logger: (...a) => logs.push(a),
        });
        server = app.listenSecure({ port: 0, host: '127.0.0.1', onListening: () => {
            port = server.address().port;
            done();
        } });
    });

    afterEach(function (done) { server.close(done); });

    const bearer = (t) => ({ authorization: 'Bearer ' + t });

    it('co-signs for the tenant the token selects', async function () {
        const r = await post(port, {
            version: 1,
            psbt: buildPsbt(acctA, 'SEND|0|TOK|5|1destX|m').toHex(),
            inputs: [{ index: 0, agentPublicNonce: nonce(acctA) }],
        }, bearer(TOKEN_A));
        expect(r.status).to.equal(200);
        expect(r.body.approved).to.equal(true);
        expect(r.body.version).to.equal(1);
        expect(r.body.signatures).to.have.length(1);
    });

    it('cannot be used to sign for ANOTHER tenant, even with a valid token', async function () {
        // The isolation property. Tenant beta's token presents tenant alpha's
        // PSBT: beta's daemon holds a different key and a different account, so
        // the prevout gate refuses. There is no request field that could have
        // addressed alpha's daemon in the first place.
        const r = await post(port, {
            version: 1,
            psbt: buildPsbt(acctA, 'SEND|0|TOK|5|1destX|m').toHex(),
            inputs: [{ index: 0, agentPublicNonce: nonce(acctA) }],
        }, bearer(TOKEN_B));
        expect(r.status).to.equal(200);
        expect(r.body.approved).to.equal(false);
        expect(r.body.reason).to.equal('PREVOUT_NOT_OUR_ACCOUNT');
    });

    it('401s an unknown token exactly as it does a missing one', async function () {
        const body = { version: 1, psbt: 'aa', inputs: [{ index: 0, agentPublicNonce: 'bb' }] };
        const unknown = await post(port, body, bearer('totally-unknown-token-abcdefgh'));
        const missing = await post(port, body, {});
        expect(unknown.status).to.equal(401);
        expect(missing.status).to.equal(401);
        // Identical answers: nothing distinguishes "no such tenant" from "no token".
        expect(unknown.body).to.deep.equal(missing.body);
    });

    it('requires an explicit, supported wire version', async function () {
        const psbt = buildPsbt(acctA, 'SEND|0|TOK|5|1destX|m').toHex();
        const inputs = [{ index: 0, agentPublicNonce: nonce(acctA) }];

        const absent = await post(port, { psbt, inputs }, bearer(TOKEN_A));
        expect(absent.status).to.equal(400);
        expect(absent.body.reason).to.equal('UNSUPPORTED_WIRE_VERSION');

        const future = await post(port, { version: 99, psbt, inputs }, bearer(TOKEN_A));
        expect(future.status).to.equal(400);
        expect(future.body.reason).to.equal('UNSUPPORTED_WIRE_VERSION');
    });

    it('rejects a malformed body with the tenant named in the log, not on the wire', async function () {
        const r = await post(port, { version: 1, psbt: 'aabb' }, bearer(TOKEN_A));
        expect(r.status).to.equal(400);
        expect(r.body.reason).to.equal('BAD_REQUEST');
        expect(JSON.stringify(r.body)).to.not.contain('alpha');
        expect(logs.some((l) => l[2] && l[2].tenant === 'alpha')).to.equal(true);
    });

    it('logs a denial with its tenant', async function () {
        const r = await post(port, {
            version: 1,
            psbt: buildPsbt(acctA, 'DESTROY|0|TOK|5|m').toHex(),      // not in allowedActions
            inputs: [{ index: 0, agentPublicNonce: nonce(acctA) }],
        }, bearer(TOKEN_A));
        expect(r.body.approved).to.equal(false);
        expect(logs.some((l) => l[2] && l[2].tenant === 'alpha' && l[2].reason)).to.equal(true);
    });

});

// The predecessor of this block asserted `expect([200, 429]).to.contain(status)`
// against a concurrency cap that could never fire, so it passed with or without
// any limit at all. These assert the limit's actual decisions instead: which
// request is refused, which tenant is unaffected, and what does not spend budget.
describe('hosted co-signer: per-tenant request budget', function () {

    let acctA, acctB, logs;
    const bearer = (t) => ({ authorization: 'Bearer ' + t });

    function appWith(opts) {
        acctA = makeAccount(); acctB = makeAccount();
        logs = [];
        return createHostedCoSignerApp(Object.assign({
            tenants: [
                { id: 'alpha', token: TOKEN_A, coSigner: tenantFor(acctA) },
                { id: 'beta',  token: TOKEN_B, coSigner: tenantFor(acctB) },
            ],
            logger: (...a) => logs.push(a),
        }, opts));
    }

    async function withServer(app, fn) {
        const srv = app.listenSecure({ port: 0, host: '127.0.0.1' });
        await new Promise((r) => srv.once('listening', r));
        try { return await fn(srv.address().port); }
        finally { await new Promise((r) => srv.close(r)); }
    }

    // A well-formed request that the daemon will judge (and deny on policy):
    // what matters here is the STATUS, which is 200 for anything the budget lets
    // through and 429 for anything it does not.
    const body = (acct) => ({
        version: 1,
        psbt: buildPsbt(acct, 'SEND|0|TOK|1|bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4').toHex(),
        inputs: [{ index: 0, agentPublicNonce: nonce(acct) }],
    });

    it('refuses the request past the budget, and names the limit', async function () {
        const app = appWith({ maxRequestsPerTenant: 2, rateWindowMs: 60000 });
        await withServer(app, async (port) => {
            const r1 = await post(port, body(acctA), bearer(TOKEN_A));
            const r2 = await post(port, body(acctA), bearer(TOKEN_A));
            const r3 = await post(port, body(acctA), bearer(TOKEN_A));
            expect([r1.status, r2.status, r3.status]).to.deep.equal([200, 200, 429]);
            expect(r3.body.reason).to.equal('TENANT_RATE_LIMIT');
            expect(r3.body.approved).to.equal(false);
            // The tenant id never rides the wire, as on every other path here.
            expect(JSON.stringify(r3.body)).to.not.contain('alpha');
            expect(logs.some((l) => l[2] && l[2].tenant === 'alpha')).to.equal(true);
        });
    });

    it('bounds one tenant without touching another', async function () {
        const app = appWith({ maxRequestsPerTenant: 1 });
        await withServer(app, async (port) => {
            expect((await post(port, body(acctA), bearer(TOKEN_A))).status).to.equal(200);
            expect((await post(port, body(acctA), bearer(TOKEN_A))).status).to.equal(429);
            // beta has its own record and its own window.
            expect((await post(port, body(acctB), bearer(TOKEN_B))).status).to.equal(200);
        });
    });

    it('does not charge a tenant for requests that never authenticate', async function () {
        // The budget is charged after the token resolves, so an anonymous flood
        // cannot exhaust a real tenant's window (nor mint a bucket of its own).
        const app = appWith({ maxRequestsPerTenant: 1 });
        await withServer(app, async (port) => {
            for (let i = 0; i < 5; i++) {
                const bad = await post(port, body(acctA), bearer('wrong-token-0123456789abcdef'));
                expect(bad.status).to.equal(401);
            }
            expect((await post(port, body(acctA), bearer(TOKEN_A))).status).to.equal(200);
        });
    });

    it('starts a fresh window once the old one expires', async function () {
        const app = appWith({ maxRequestsPerTenant: 1, rateWindowMs: 1 });
        await withServer(app, async (port) => {
            expect((await post(port, body(acctA), bearer(TOKEN_A))).status).to.equal(200);
            await new Promise((r) => setTimeout(r, 15));
            expect((await post(port, body(acctA), bearer(TOKEN_A))).status).to.equal(200);
        });
    });

    it('is off unless the operator asks for it', async function () {
        const app = appWith({});
        await withServer(app, async (port) => {
            for (let i = 0; i < 6; i++)
                expect((await post(port, body(acctA), bearer(TOKEN_A))).status).to.equal(200);
        });
    });

    it('refuses the removed maxInflightPerTenant option loudly, naming its successor', function () {
        // A caller who set the old option believed a concurrency cap was
        // protecting the shared core; it never could, so this must not become a
        // silent no-op on upgrade.
        const a = makeAccount();
        expect(() => createHostedCoSignerApp({
            tenants: [{ id: 'solo', token: TOKEN_A, coSigner: tenantFor(a) }],
            maxInflightPerTenant: 1,
        })).to.throw(/maxInflightPerTenant was removed[\s\S]*maxRequestsPerTenant/);
    });

    // The hosted surface carried the same hardcoded 256kb cap as the sidecar and
    // must answer an oversize body the same named way, so a request cannot
    // succeed on one transport and read as a dead daemon on the other.
    it('names an oversize body 413 REQUEST_TOO_LARGE, with no version echoed', async function () {
        const app = appWith({ maxBodyBytes: 4096 });
        await withServer(app, async (port) => {
            const r = await post(port, { version: 1, psbt: 'aa'.repeat(8000),
                inputs: [{ index: 0, agentPublicNonce: 'bb' }] }, bearer(TOKEN_A));
            expect(r.status).to.equal(413);
            expect(r.body.reason).to.equal('REQUEST_TOO_LARGE');
            expect(r.body.approved).to.equal(false);
            // The body never parsed, so there is no version to echo (as on 401).
            expect(r.body).to.not.have.property('version');
            expect(JSON.stringify(r.body)).to.not.contain('alpha');
        });
    });

    it('accepts a body far larger than the old 256kb cap by default', async function () {
        const app = appWith({});
        await withServer(app, async (port) => {
            const r = await post(port, Object.assign(body(acctA),
                { envelope: { script: 'ab'.repeat(300000) } }), bearer(TOKEN_A));
            expect(r.status).to.equal(200);          // judged, not refused by the transport
            expect(r.body).to.have.property('approved');
        });
    });

    it('rejects a nonsensical budget or window at construction', function () {
        const a = makeAccount();
        const tenants = [{ id: 'solo', token: TOKEN_A, coSigner: tenantFor(a) }];
        expect(() => createHostedCoSignerApp({ tenants, maxRequestsPerTenant: -1 }))
            .to.throw(/maxRequestsPerTenant/);
        expect(() => createHostedCoSignerApp({ tenants, maxRequestsPerTenant: 1.5 }))
            .to.throw(/maxRequestsPerTenant/);
        expect(() => createHostedCoSignerApp({ tenants, rateWindowMs: 0 }))
            .to.throw(/rateWindowMs/);
    });
});
