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
 * XChain Platform SDK - API batch fan-out cap tests
 *
 * express-json-rpc-router dispatches every element of an array body, and the
 * body-size limit bounds BYTES, not call count: one ~100KB body carries
 * thousands of {"method":"ping"} calls, so a single request amplified into
 * thousands of concurrent backend RPCs.
 *
 * src/api.js starts a live server at require time, so these tests mount the
 * SHIPPED middleware from src/apiGuards.js (the same function src/api.js
 * mounts) rather than a copy of it, and a source check pins that api.js still
 * mounts it ahead of the auth gate and the router.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const http   = require('http');
const express = require('express');
const bodyParser = require('body-parser');
const { batchCapMiddleware, resolveMaxBatch } = require('../../src/apiGuards.js');

function buildApp(maxBatch) {
    const app = express();
    app.use(bodyParser.json());
    // The shipped guard itself, not a reconstruction of it.
    app.use(batchCapMiddleware(maxBatch));
    // Stands in for the auth gate + router: reaching it means the cap let the
    // body through, which is exactly what must not happen for an oversized batch.
    app.use((req, res) => res.status(200).json({ jsonrpc: '2.0', id: null, result: 'dispatched' }));
    return app;
}

async function request(app, body) {
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
        const res = await fetch(`http://127.0.0.1:${port}/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        return { status: res.status, json: await res.json() };
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

function pings(n) {
    return Array.from({ length: n }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'ping' }));
}

describe('API JSON-RPC batch fan-out cap', function () {
    this.timeout(10000);

    it('rejects an oversized batch before anything is dispatched', async () => {
        const r = await request(buildApp(20), pings(21));
        assert.strictEqual(r.status, 400);
        assert.strictEqual(r.json.error.code, -32600);
        assert.match(r.json.error.message, /batch of 21 calls exceeds the maximum of 20/);
    });

    it('rejects the unauthenticated ping amplification path too (cap precedes auth)', async () => {
        const r = await request(buildApp(20), pings(2000));
        assert.strictEqual(r.status, 400);
    });

    it('passes a batch at exactly the cap', async () => {
        const r = await request(buildApp(20), pings(20));
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.json.result, 'dispatched');
    });

    it('never rejects a single (non-array) call body', async () => {
        const r = await request(buildApp(1), { jsonrpc: '2.0', id: 1, method: 'create_action' });
        assert.strictEqual(r.status, 200);
    });

    it('enforces the default cap the shipped config resolver produces', async () => {
        // Runs the real parser and the real middleware together, so a regression
        // in either the default or the comparison shows up here.
        const r = await request(buildApp(resolveMaxBatch({})), pings(21));
        assert.strictEqual(r.status, 400);
        assert.match(r.json.error.message, /exceeds the maximum of 20/);
    });

    it('falls back to the default cap on a junk or disabling env value', () => {
        // A cap that parses to NaN and is then used in a > comparison never fires,
        // so the fallback is the whole guard.
        assert.strictEqual(resolveMaxBatch({}), 20);
        assert.strictEqual(resolveMaxBatch({ SDK_API_MAX_BATCH: 'lots' }), 20);
        assert.strictEqual(resolveMaxBatch({ SDK_API_MAX_BATCH: '' }), 20);
        assert.strictEqual(resolveMaxBatch({ SDK_API_MAX_BATCH: '0' }), 20);
        assert.strictEqual(resolveMaxBatch({ SDK_API_MAX_BATCH: '-5' }), 20);
        assert.strictEqual(resolveMaxBatch({ SDK_API_MAX_BATCH: '50' }), 50);
    });

    it('src/api.js mounts the batch cap BEFORE the auth gate and the jsonRouter mount', () => {
        const src = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8');
        const capIdx    = src.indexOf('app.use(batchCapMiddleware(');
        // Anchored on the MOUNT, not on a compare inside the gate body: the gate
        // now lives in src/apiGuards.js, and an anchor that can go missing makes
        // every ordering assertion below it argue from -1.
        const authIdx   = src.indexOf('app.use(authGateMiddleware(');
        const routerIdx = src.indexOf('jsonRouter(');
        assert.notStrictEqual(capIdx, -1, 'batch cap not mounted in src/api.js');
        assert.notStrictEqual(authIdx, -1, 'auth gate missing from src/api.js');
        assert.notStrictEqual(routerIdx, -1, 'jsonRouter mount missing from src/api.js');
        assert.ok(capIdx < authIdx, 'the cap must run before the auth gate');
        assert.ok(capIdx < routerIdx, 'the cap must run before the router dispatches');
    });

    it('keeps ONE implementation of the cap: api.js holds no inline copy', () => {
        const src = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8');
        // A second inline copy is how the behavioural tests above stop covering
        // the shipped path, so the tests refuse to let one come back.
        assert.ok(!/req\.body\.length\s*>/.test(src),
            'src/api.js re-implements the batch cap inline; it must mount batchCapMiddleware instead');
    });
});
