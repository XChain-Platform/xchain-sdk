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
// Stage 3 of the co-signer hardening: G13 (client-visible error codes), G14
// (input-count cap), G17 (fault and denial logging) and the removal of the
// accountScript override. Every case fails against the code as it stood before
// its gap was closed.

const { expect } = require('chai');
const http    = require('http');
const crypto  = require('crypto');
require('../../src/applyBufferutilsPatch.js');
const bitcoin = require('bitcoinjs-lib');
const { secp256k1 } = require('@noble/curves/secp256k1');
const MuSig2   = require('../../src/musig2.js');
const CoSigner = require('../../src/cosigner/coSigner.js');
const { httpTransport } = require('../../src/cosigner/client.js');
const { createCoSignerApp } = require('../../src/cosigner/server.js');

function makeAccount() {
    const musig   = new MuSig2();
    const agentSk = crypto.randomBytes(32);
    const coSk    = crypto.randomBytes(32);
    const agentPk = secp256k1.getPublicKey(agentSk, true);
    const coPk    = secp256k1.getPublicKey(coSk, true);
    const keys    = [agentPk, coPk];
    const bare    = musig.aggregateKeys(keys);
    const p2tr    = bitcoin.payments.p2tr({ pubkey: Buffer.from(bare.xOnlyPubkey) });
    return { musig, agentSk, coSk, agentPk, coPk, keys, p2trScript: p2tr.output };
}

function carrier(actionString, txidHex) {
    const inner  = bitcoin.script.compile([Buffer.from(actionString, 'utf8')]);
    const tagged = Buffer.concat([Buffer.from('XCHN'), inner]);
    const cipher = crypto.createCipheriv('aes-128-ctr', txidHex.substr(0, 16), txidHex.substr(16, 16));
    return Buffer.concat([cipher.update(tagged), cipher.final()]);
}

// A PSBT with `inputCount` inputs, all spending the account.
function buildPsbt(acct, actionString, inputCount = 1) {
    const prevHash = crypto.randomBytes(32);
    const txid = Buffer.from(prevHash).reverse().toString('hex');
    const psbt = new bitcoin.Psbt();
    psbt.addInput({ hash: prevHash, index: 0, witnessUtxo: { script: acct.p2trScript, value: 100000 } });
    for (let i = 1; i < inputCount; i++)
        psbt.addInput({ hash: crypto.randomBytes(32), index: 0,
            witnessUtxo: { script: acct.p2trScript, value: 1000 } });
    psbt.addOutput({ script: bitcoin.payments.embed({ data: [carrier(actionString, txid)] }).output, value: 0 });
    psbt.addOutput({ script: acct.p2trScript, value: 90000 });
    return psbt;
}

function nonce(acct) {
    return new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk });
}

/* ────────────────────────────────────────────────────────────────────────
 * G14 - bound the WORK, not just the bytes
 * ──────────────────────────────────────────────────────────────────────── */

describe('G14: input-count cap', function () {

    it('refuses more requested inputs than the cap', function () {
        // The 256kb body limit bounds bytes, not work: sighash derivation is
        // quadratic in the input count plus a deterministicSign each, so one
        // crafted request could occupy the single-threaded sidecar for seconds.
        // A frozen daemon is, per the threat model, permanently stuck funds.
        const acct = makeAccount();
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys,
            policy: { allowedActions: new Set(['SEND']) }, maxCosignInputs: 4 });
        const psbt = buildPsbt(acct, 'SEND|0|TOK|5|1destX|m', 4);
        const inputs = [0, 1, 2, 3, 0].map((index) => ({ index, agentPublicNonce: nonce(acct) }));

        const res = co.process({ psbt: psbt.toHex(), inputs });
        expect(res.approved).to.equal(false);
        expect(res.reason).to.equal('TOO_MANY_INPUTS');
        expect(res.detail.max).to.equal(4);
    });

    it('refuses a huge PSBT even when only one input is requested', function () {
        // The BIP341 sighash commits to EVERY prevout, so a one-element request
        // against a large PSBT still pays the full walk. Capping only the request
        // would leave the cheap version of the same denial of service open.
        const acct = makeAccount();
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys,
            policy: { allowedActions: new Set(['SEND']) }, maxCosignInputs: 4 });
        const psbt = buildPsbt(acct, 'SEND|0|TOK|5|1destX|m', 10);

        const res = co.process({ psbt: psbt.toHex(), inputs: [{ index: 0, agentPublicNonce: nonce(acct) }] });
        expect(res.approved).to.equal(false);
        expect(res.reason).to.equal('TOO_MANY_INPUTS');
        expect(res.detail.psbtInputs).to.equal(10);
    });

    it('defaults the cap to 32 and still approves an ordinary spend', function () {
        const acct = makeAccount();
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys,
            policy: { allowedActions: new Set(['SEND']) } });
        expect(co.maxCosignInputs).to.equal(32);
        expect(co.process({
            psbt: buildPsbt(acct, 'SEND|0|TOK|5|1destX|m').toHex(),
            inputs: [{ index: 0, agentPublicNonce: nonce(acct) }],
        }).approved).to.equal(true);
    });

    it('rejects a nonsense cap at construction', function () {
        const acct = makeAccount();
        expect(() => new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys,
            policy: { allowedActions: new Set(['SEND']) }, maxCosignInputs: 0 }))
            .to.throw(/maxCosignInputs/);
    });
});

/* ────────────────────────────────────────────────────────────────────────
 * accountScript override removal
 * ──────────────────────────────────────────────────────────────────────── */

describe('accountScript override is gone', function () {

    it('ignores a supplied accountScript and derives from the participant keys', function () {
        // The override had no consumer and its only effect was to WEAKEN the
        // prevout gate - the one gate proving the inputs being signed belong to
        // this account. A wrong value was at best a liveness break.
        const acct  = makeAccount();
        const other = makeAccount();
        const co = new CoSigner({
            secretKey: acct.coSk, publicKeys: acct.keys,
            policy: { allowedActions: new Set(['SEND']) },
            accountScript: other.p2trScript,
        });
        expect(co.accountScript.equals(acct.p2trScript)).to.equal(true);
        expect(co.accountScript.equals(other.p2trScript)).to.equal(false);
    });

    it('the prevout gate cannot be pointed at a foreign account', function () {
        const acct  = makeAccount();
        const other = makeAccount();
        const co = new CoSigner({
            secretKey: acct.coSk, publicKeys: acct.keys,
            policy: { allowedActions: new Set(['SEND']) },
            accountScript: other.p2trScript,
        });
        const res = co.process({
            psbt: buildPsbt(other, 'SEND|0|TOK|5|1destX|m').toHex(),
            inputs: [{ index: 0, agentPublicNonce: nonce(acct) }],
        });
        expect(res.approved).to.equal(false);
        expect(res.reason).to.equal('PREVOUT_NOT_OUR_ACCOUNT');
    });
});

/* ────────────────────────────────────────────────────────────────────────
 * G13 - non-200 reasons must reach the SDK caller
 * ──────────────────────────────────────────────────────────────────────── */

describe('G13: client-visible error codes', function () {

    // A fetch stub standing in for the sidecar, so the status/body pairs under
    // test are exactly the documented ones.
    function fakeFetch(status, body, { json = true } = {}) {
        return async () => ({
            ok: status >= 200 && status < 300,
            status,
            json: async () => {
                if (!json) throw new SyntaxError('Unexpected token < in JSON');
                return body;
            },
        });
    }

    async function codeFor(status, body, opts) {
        const transport = httpTransport('http://127.0.0.1:8787', { fetch: fakeFetch(status, body, opts) });
        try {
            await transport({ psbt: 'aa', inputs: [] });
            return null;
        } catch (e) { return e.code; }
    }

    it('surfaces UNAUTHORIZED rather than a generic transport error', async function () {
        // The distinction an operator needs mid-incident: before this, a rotated
        // or mistyped token was indistinguishable from a dead sidecar.
        expect(await codeFor(401, { approved: false, reason: 'UNAUTHORIZED' })).to.equal('UNAUTHORIZED');
    });

    it('surfaces BAD_REQUEST', async function () {
        expect(await codeFor(400, { approved: false, reason: 'BAD_REQUEST', detail: 'psbt required' }))
            .to.equal('BAD_REQUEST');
    });

    it('surfaces INTERNAL_ERROR', async function () {
        expect(await codeFor(500, { approved: false, reason: 'INTERNAL_ERROR' })).to.equal('INTERNAL_ERROR');
    });

    it('still collapses a proxy error page to COSIGNER_TRANSPORT_ERROR', async function () {
        // A reverse proxy answering 502 with HTML is a genuine transport fault and
        // must stay distinguishable from a daemon that answered.
        expect(await codeFor(502, null, { json: false })).to.equal('COSIGNER_TRANSPORT_ERROR');
    });

    it('collapses a 2xx non-JSON body to COSIGNER_TRANSPORT_ERROR', async function () {
        expect(await codeFor(200, null, { json: false })).to.equal('COSIGNER_TRANSPORT_ERROR');
    });

    it('passes a normal 200 body straight through', async function () {
        const transport = httpTransport('http://127.0.0.1:8787',
            { fetch: fakeFetch(200, { approved: true, signatures: [] }) });
        const res = await transport({ psbt: 'aa', inputs: [] });
        expect(res.approved).to.equal(true);
    });
});

/* ────────────────────────────────────────────────────────────────────────
 * G17 - faults and denials must be visible to the operator
 * ──────────────────────────────────────────────────────────────────────── */

describe('G17: fault and denial logging', function () {

    // Real HTTP against a listening app, mirroring coSignerServer.test.js: the
    // express internals are not a stable enough surface to reach into.
    function serve(coSignerStub, opts) {
        return new Promise((resolve) => {
            const app = createCoSignerApp(coSignerStub, opts);
            const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
        });
    }

    function post(port, body, headers) {
        return new Promise((resolve, reject) => {
            const data = Buffer.from(JSON.stringify(body));
            const req = http.request({
                host: '127.0.0.1', port, path: '/cosign', method: 'POST',
                headers: Object.assign(
                    { 'content-type': 'application/json', 'content-length': data.length }, headers || {}),
            }, (res) => {
                let chunks = '';
                res.on('data', (c) => { chunks += c; });
                res.on('end', () => resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }));
            });
            req.on('error', reject);
            req.write(data); req.end();
        });
    }

    // Run one request against a throwaway sidecar and hand back its logs.
    async function run(coSignerStub, opts, body, headers) {
        const logs = [];
        const { server, port } = await serve(coSignerStub,
            Object.assign({ logger: (...a) => logs.push(a) }, opts));
        try {
            const res = await post(port, body, headers);
            return { res, logs };
        } finally {
            await new Promise((r) => server.close(r));
        }
    }

    const psbtBody = { psbt: 'aabb', inputs: [{ index: 0, agentPublicNonce: 'cc' }] };

    it('logs an internal fault with its stack before answering INTERNAL_ERROR', async function () {
        // Before this, a poisoned-tick freeze and a corrupt window store both
        // presented as an unexplained 500 with the error discarded entirely.
        const throwing = { process() {
            const e = new Error('window state is unreadable');
            e.code = 'WINDOW_STATE_CORRUPT';
            throw e;
        } };
        const { res, logs } = await run(throwing, { allowUnauthenticated: true }, psbtBody);
        expect(res.status).to.equal(500);
        expect(res.body.reason).to.equal('INTERNAL_ERROR');
        // The wire stays detail-free; the diagnosis goes to the log.
        expect(res.body.detail).to.equal(undefined);

        const fault = logs.find((l) => l[0] === 'error');
        expect(fault, 'the fault was logged').to.not.equal(undefined);
        expect(fault[2].message).to.match(/unreadable/);
        expect(fault[2].code).to.equal('WINDOW_STATE_CORRUPT');
        expect(fault[2].stack).to.be.a('string');
    });

    it('logs every denial reason, which nothing else persists', async function () {
        // The window store records only APPROVALS, so without this there is no
        // refusal trail at all.
        const denying = { process: () => ({ approved: false, reason: 'POLICY_ACTION_DENIED', detail: { action: 'SEND' } }) };
        const { res, logs } = await run(denying, { allowUnauthenticated: true }, psbtBody);
        expect(res.status).to.equal(200);          // a denial is a legitimate answer
        expect(logs.some((l) => l[2] && l[2].reason === 'POLICY_ACTION_DENIED'),
            'the denial was logged').to.equal(true);
    });

    it('logs a rejected bearer token', async function () {
        const { res, logs } = await run({ process: () => ({ approved: true }) },
            { token: 'sekret' }, psbtBody, { authorization: 'Bearer wrong!' });
        expect(res.status).to.equal(401);
        expect(logs.some((l) => /bearer token/.test(l[1]))).to.equal(true);
    });

    it('logs a malformed request body', async function () {
        const { res, logs } = await run({ process: () => ({ approved: true }) },
            { allowUnauthenticated: true }, { psbt: 'aabb' });     // no inputs[]
        expect(res.status).to.equal(400);
        expect(logs.some((l) => /malformed body/.test(l[1]))).to.equal(true);
    });

    it('an approval is not logged as a denial', async function () {
        const { logs } = await run({ process: () => ({ approved: true, action: 'SEND', signatures: [] }) },
            { allowUnauthenticated: true }, psbtBody);
        expect(logs).to.have.length(0);
    });

    it('a throwing log sink never breaks enforcement', async function () {
        const app = createCoSignerApp({ process: () => ({ approved: false, reason: 'POLICY_ACTION_DENIED' }) },
            { allowUnauthenticated: true, logger: () => { throw new Error('log sink down'); } });
        const server = app.listen(0, '127.0.0.1');
        await new Promise((r) => server.once('listening', r));
        try {
            const res = await post(server.address().port, psbtBody);
            expect(res.status).to.equal(200);
            expect(res.body.reason).to.equal('POLICY_ACTION_DENIED');
        } finally {
            await new Promise((r) => server.close(r));
        }
    });
});

/* ────────────────────────────────────────────────────────────────────────
 * Bounded rest-field EXECUTE decode (the envelope extension)
 * ──────────────────────────────────────────────────────────────────────── */

describe('bounded rest-field EXECUTE decode', function () {

    const { decodeActionFromPsbt } = require('../../src/cosigner/psbtActionDecode.js');
    const valueDerivability = require('../../src/cosigner/valueDerivability.js');

    it('an agent behind a co-signer can now call a contract at all', function () {
        // Before this, EXECUTE's only wire format ended in ...PARAMS and the
        // decoder refused every rest field outright, so contract calls were
        // outside the envelope regardless of what the policy allowed.
        const acct = makeAccount();
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys,
            policy: { allowedActions: new Set(['EXECUTE']), maxPerWindow: { hours: 24, maxActions: 10 } },
            windowStore: {
                snapshot: () => ({ count: 0, perTick: {} }),
                record: () => {},
            } });
        const res = co.process({
            psbt: buildPsbt(acct, 'EXECUTE|0|1632|add|5|7').toHex(),
            inputs: [{ index: 0, agentPublicNonce: nonce(acct) }],
        });
        expect(res.approved).to.equal(true);
    });

    it('is refused whenever the policy carries ANY amount limit', function () {
        // This is what makes the bounded parse safe. An EXECUTE's value is set by
        // the CONTRACT's code, not the action string, so no amount cap could ever
        // count it correctly - and rather than let one silently under-count, the
        // action is refused outright while any cap is set.
        const acct = makeAccount();
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys,
            policy: { allowedActions: new Set(['EXECUTE']), maxPerAction: { SEND: { '*': '10' } } } });
        const res = co.process({
            psbt: buildPsbt(acct, 'EXECUTE|0|1632|add|5|7').toHex(),
            inputs: [{ index: 0, agentPublicNonce: nonce(acct) }],
        });
        expect(res.approved).to.equal(false);
        expect(res.reason).to.equal('POLICY_UNBOUNDED_ACTION');
    });

    it('rejects an amount cap naming EXECUTE at construction', function () {
        // Every decodable EXECUTE format is value-by-reference, so such a cap
        // could never bind - the same config error as maxPerAction.COINPAY.
        const acct = makeAccount();
        expect(() => new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys,
            policy: { allowedActions: new Set(['EXECUTE']), maxPerAction: { EXECUTE: { '*': '10' } } } }))
            .to.throw(/can never bind/);
    });

    it('still refuses every rest field that has NOT been analysed', function () {
        // The allowlist is per (action, version); LIST's ...ITEM is not on it.
        const acct = makeAccount();
        const d = decodeActionFromPsbt(buildPsbt(acct, 'LIST|0|my list|a|b|c'));
        expect(d.ok).to.equal(false);
        expect(d.reason).to.equal('REST_FIELD_UNSUPPORTED');
    });

    it('bounds the params so one request cannot become unbounded work', function () {
        const acct = makeAccount();
        const many = Array.from({ length: 40 }, (_, i) => String(i)).join('|');
        const d = decodeActionFromPsbt(buildPsbt(acct, 'EXECUTE|0|1632|spray|' + many));
        expect(d.ok).to.equal(false);
        expect(d.reason).to.equal('REST_FIELD_TOO_LONG');
    });

    it('EXECUTE is classified, and classified UNBOUNDED', function () {
        const c = valueDerivability.classify('EXECUTE', 0, {});
        expect(c.class).to.equal(valueDerivability.UNBOUNDED);
        expect(c.byRef).to.equal(true);
    });
});
