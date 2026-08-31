/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Platform SDK - API bearer-token auth gate tests
 *
 * These mount the SHIPPED gate from src/apiGuards.js (the same function
 * src/api.js mounts), not a reconstruction of it: src/api.js starts a live
 * server at require time (dotenv.config() + app.listen(SDK_API_PORT)) and so
 * cannot be require()'d by a unit test, which is exactly why the guards live in
 * their own module. A copied middleware here would stay green while the shipped
 * gate regressed, and it did: the batch-smuggling rule the gate's own comment
 * justifies had no case at all, and the untyped method compare that answered an
 * HTML 500 on a pre-auth path was copied into the reconstruction verbatim.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const http   = require('http');
const express = require('express');
const bodyParser = require('body-parser');
const { authGateMiddleware } = require('../../src/apiGuards.js');

function buildApp(SDK_API_KEY) {
    const app = express();
    app.use(bodyParser.json());
    // The shipped gate itself, not a reconstruction of it.
    app.use(authGateMiddleware({ apiKey: SDK_API_KEY }));
    // Stands in for the jsonRouter mount: reaching it means the gate let the
    // body through, which is what must not happen unauthenticated.
    app.use((req, res) => {
        let body = req.body || {};
        if (Array.isArray(body) ? false : body.method === 'ping')
            return res.status(200).json({ jsonrpc: '2.0', id: body.id, result: { status: 'success' } });
        return res.status(200).json({ jsonrpc: '2.0', id: (body && body.id) || null, result: 'ok' });
    });
    return app;
}

async function request(app, { headers = {}, body } = {}) {
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
        const res = await fetch(`http://127.0.0.1:${port}/`, {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
            body: JSON.stringify(body),
        });
        return { status: res.status, json: await res.json() };
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

describe('API bearer-token auth gate', function () {
    this.timeout(10000);
    const KEY = 'correct-horse-battery-staple';

    it('accepts the correct token for a non-ping method', async () => {
        const r = await request(buildApp(KEY), {
            headers: { authorization: 'Bearer ' + KEY },
            body: { jsonrpc: '2.0', id: 1, method: 'create_action' },
        });
        assert.strictEqual(r.status, 200);
    });

    it('rejects a wrong token of the SAME length', async () => {
        const wrong = KEY.split('').reverse().join('');
        assert.strictEqual(wrong.length, KEY.length);
        const r = await request(buildApp(KEY), {
            headers: { authorization: 'Bearer ' + wrong },
            body: { jsonrpc: '2.0', id: 1, method: 'create_action' },
        });
        assert.strictEqual(r.status, 401);
        assert.strictEqual(r.json.error.code, -32001);
    });

    it('rejects a wrong token of a DIFFERENT length', async () => {
        const r = await request(buildApp(KEY), {
            headers: { authorization: 'Bearer short' },
            body: { jsonrpc: '2.0', id: 1, method: 'create_action' },
        });
        assert.strictEqual(r.status, 401);
    });

    it('rejects a missing authorization header', async () => {
        const r = await request(buildApp(KEY), {
            body: { jsonrpc: '2.0', id: 1, method: 'create_action' },
        });
        assert.strictEqual(r.status, 401);
    });

    it('rejects a malformed authorization header', async () => {
        const r = await request(buildApp(KEY), {
            headers: { authorization: KEY },
            body: { jsonrpc: '2.0', id: 1, method: 'create_action' },
        });
        assert.strictEqual(r.status, 401);
    });

    it('rejects a non-Bearer scheme', async () => {
        const r = await request(buildApp(KEY), {
            headers: { authorization: 'Basic ' + KEY },
            body: { jsonrpc: '2.0', id: 1, method: 'create_action' },
        });
        assert.strictEqual(r.status, 401);
    });

    it('with SDK_API_KEY unset, still rejects a non-ping method (fails closed)', async () => {
        const r = await request(buildApp(''), {
            headers: { authorization: 'Bearer anything' },
            body: { jsonrpc: '2.0', id: 1, method: 'create_action' },
        });
        assert.strictEqual(r.status, 401);
    });

    it('with SDK_API_KEY unset, ping still succeeds unauthenticated', async () => {
        const r = await request(buildApp(''), {
            body: { jsonrpc: '2.0', id: 1, method: 'ping' },
        });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.json.result.status, 'success');
    });

    // The batch rule the gate's own comment justifies. Reading req.body.method
    // off an array leaves it undefined, so a regression to a single-object read
    // would let these batches through unauthenticated; it was live in four
    // services on 2026-07-07 and patched here with no test.

    it('rejects a batch smuggling a non-ping method behind a leading ping', async () => {
        const r = await request(buildApp(KEY), {
            body: [
                { jsonrpc: '2.0', id: 1, method: 'ping' },
                { jsonrpc: '2.0', id: 2, method: 'create_action' },
            ],
        });
        assert.strictEqual(r.status, 401);
        assert.strictEqual(r.json.error.code, -32001);
        assert.strictEqual(r.json.id, null, 'a batch rejection carries no single id');
    });

    it('accepts the same batch with the correct token', async () => {
        const r = await request(buildApp(KEY), {
            headers: { authorization: 'Bearer ' + KEY },
            body: [
                { jsonrpc: '2.0', id: 1, method: 'ping' },
                { jsonrpc: '2.0', id: 2, method: 'create_action' },
            ],
        });
        assert.strictEqual(r.status, 200);
    });

    it('lets an all-ping batch through unauthenticated', async () => {
        const r = await request(buildApp(KEY), {
            body: [{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'ping' }],
        });
        assert.strictEqual(r.status, 200);
    });

    it('with SDK_API_KEY unset, rejects a batch containing a non-ping method', async () => {
        const r = await request(buildApp(''), {
            headers: { authorization: 'Bearer anything' },
            body: [{ method: 'ping' }, { method: 'create_action' }],
        });
        assert.strictEqual(r.status, 401);
    });

    // A caller-controlled method is not necessarily a string, and nothing
    // upstream types it: the router is the first layer that would reject a
    // non-string method and it mounts after this gate. Calling .toLowerCase() on
    // whatever arrives threw inside the middleware, and with no error handler on
    // the stack Express answered its default HTML 500 on a PRE-AUTH path.

    it('answers a JSON-RPC 401, not an HTML 500, for a numeric method', async () => {
        const r = await request(buildApp(KEY), {
            body: { jsonrpc: '2.0', id: 1, method: 123 },
        });
        assert.strictEqual(r.status, 401);
        assert.strictEqual(r.json.error.code, -32001);
        assert.strictEqual(r.json.id, 1);
    });

    it('answers a JSON-RPC 401 for an array-valued method', async () => {
        const r = await request(buildApp(KEY), { body: { method: ['ping'] } });
        assert.strictEqual(r.status, 401);
        assert.strictEqual(r.json.error.code, -32001);
    });

    it('answers a JSON-RPC 401 for an object-valued method', async () => {
        const r = await request(buildApp(KEY), { body: { method: { toLowerCase: 'ping' } } });
        assert.strictEqual(r.status, 401);
    });

    it('demands the key for a present-but-falsy non-string method (fails closed)', async () => {
        for (const method of [0, false]) {
            const r = await request(buildApp(KEY), { body: { jsonrpc: '2.0', id: 1, method } });
            assert.strictEqual(r.status, 401, 'method ' + JSON.stringify(method) + ' must demand the key');
        }
    });

    it('demands the key for an empty-string method', async () => {
        const r = await request(buildApp(KEY), { body: { jsonrpc: '2.0', id: 1, method: '' } });
        assert.strictEqual(r.status, 401);
    });

    it('rejects a batch smuggling a non-string method', async () => {
        const r = await request(buildApp(KEY), {
            body: [{ method: 'ping' }, { method: 123 }],
        });
        assert.strictEqual(r.status, 401);
    });

    it('passes a non-string method through once authenticated, for the router to reject', async () => {
        const r = await request(buildApp(KEY), {
            headers: { authorization: 'Bearer ' + KEY },
            body: { jsonrpc: '2.0', id: 1, method: 123 },
        });
        assert.strictEqual(r.status, 200, 'the gate authenticates; -32600 is the router\'s call');
    });

    it('leaves a bodyless request open, as GET /openrpc.json presents it', async () => {
        // Express 5 leaves req.body undefined with no JSON body; an ABSENT
        // method must stay open or the spec route 401s. Only a PRESENT
        // non-string method demands the key.
        const app = buildApp(KEY);
        const server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        try {
            const res = await fetch(`http://127.0.0.1:${port}/openrpc.json`);
            assert.strictEqual(res.status, 200);
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    it('src/api.js mounts the shipped gate before the jsonRouter mount', () => {
        const src = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8');
        const gateIdx   = src.indexOf('app.use(authGateMiddleware(');
        const routerIdx = src.indexOf('jsonRouter(');
        assert.notStrictEqual(gateIdx, -1, 'auth gate not mounted in src/api.js');
        assert.notStrictEqual(routerIdx, -1, 'jsonRouter mount missing from src/api.js');
        assert.ok(gateIdx < routerIdx, 'auth gate must be registered before the jsonRouter mount');
    });

    it('keeps the timing-safe compare, in the guard module the gate now lives in', () => {
        const guards = fs.readFileSync(path.join(__dirname, '../../src/apiGuards.js'), 'utf8');
        assert.notStrictEqual(guards.indexOf("require('./utils/safeCompare.js')"), -1,
            'safeCompare require missing from src/apiGuards.js');
        assert.notStrictEqual(guards.indexOf('safeTokenEqual(got, apiKey)'), -1,
            'the auth gate must compare the bearer token with safeTokenEqual');
    });

    it('keeps ONE implementation of the gate: api.js holds no inline copy', () => {
        const src = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8');
        // A second inline copy is how the behavioural tests above stop covering
        // the shipped path, so the tests refuse to let one come back.
        assert.ok(!/safeTokenEqual\(got,/.test(src),
            'src/api.js re-implements the auth gate inline; it must mount authGateMiddleware instead');
    });
});
