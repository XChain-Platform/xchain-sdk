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

// The suite above drives the daemon in process, which is exactly the path that
// does NOT exercise either HTTP surface's request forwarding. A dropped
// `envelope` field there fails closed rather than dangerously, but it would make
// the same request succeed on one deployment and fail on another, which is the
// kind of divergence that only shows up in production. So drive it over real
// HTTP once, end to end, through the shipped sidecar.
const http = require('http');
const { createCoSignerApp } = require('../../../src/cosigner/server.js');
const { createHostedCoSignerApp } = require('../../../src/cosigner/hosted_server.js');

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

function envelopeRequest(acct, commit, script) {
    return {
        psbt: buildRevealPsbt(acct, commit).toHex(),
        envelope: { script: script.toString('hex') },
        inputs: [{ index: 0, agentPublicNonce: Buffer.from(
            new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk })).toString('hex') }],
    };
}

describe('co-signer: the envelope survives the wire', function () {
    it('the single-tenant sidecar forwards it (a reveal approves over HTTP)', async function () {
        const acct = makeAccount();
        const { script, commit } = commitFor(acct);
        const app = createCoSignerApp(makeCoSigner(acct), { token: 'sekret' });
        const server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
        try {
            const port = server.address().port;
            const ok = await post(port, '/cosign', envelopeRequest(acct, commit, script),
                { authorization: 'Bearer sekret' });
            expect(ok.status).to.equal(200);
            expect(ok.body.approved).to.equal(true);
            expect(ok.body.envelopeRole).to.equal('reveal');

            // Same request with the envelope field stripped must NOT approve:
            // that is what proves the approval above came from the forwarded
            // field rather than from the request happening to pass anyway.
            const stripped = envelopeRequest(acct, commit, script);
            delete stripped.envelope;
            const denied = await post(port, '/cosign', stripped, { authorization: 'Bearer sekret' });
            expect(denied.body.approved).to.equal(false);
        } finally {
            await new Promise((res) => server.close(res));
        }
    });
});

describe('co-signer: the envelope survives the wire', function () {
    it('the hosted multi-tenant surface forwards it too', async function () {
        // The hosted surface has its own construction contract: a >=16-char
        // tenant token, an explicit wire version on every request, and
        // listenSecure rather than listen.
        const HOSTED_TOKEN = 'tenant-envelope-token-0123456789';
        const acct = makeAccount();
        const { script, commit } = commitFor(acct);
        const app = createHostedCoSignerApp({
            tenants: [{ id: 't1', token: HOSTED_TOKEN, coSigner: makeCoSigner(acct) }],
        });
        const server = await new Promise((res) => {
            const s = app.listenSecure({ port: 0, host: '127.0.0.1', onListening: () => res(s) });
        });
        try {
            const port = server.address().port;
            const body = Object.assign({ version: 1 }, envelopeRequest(acct, commit, script));
            const ok = await post(port, '/v1/cosign', body, { authorization: 'Bearer ' + HOSTED_TOKEN });
            expect(ok.status).to.equal(200);
            expect(ok.body.approved).to.equal(true);
            expect(ok.body.envelopeRole).to.equal('reveal');

            const stripped = Object.assign({ version: 1 }, envelopeRequest(acct, commit, script));
            delete stripped.envelope;
            const denied = await post(port, '/v1/cosign', stripped, { authorization: 'Bearer ' + HOSTED_TOKEN });
            expect(denied.body.approved).to.equal(false);
        } finally {
            await new Promise((res) => server.close(res));
        }
    });
});
