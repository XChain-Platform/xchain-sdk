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
 * src/api.js starts a live server at require time (dotenv.config() +
 * app.listen(SDK_API_PORT)), so it can't be require()'d directly in a unit
 * test (see test/unit/jsonrpc-body-guard.test.js for the established
 * pattern this file follows). This reconstructs the exact auth-gate
 * middleware from src/api.js and asserts, via a source-fidelity check, that
 * the live file still wires safeTokenEqual the same way.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const http   = require('http');
const express = require('express');
const bodyParser = require('body-parser');
const { safeTokenEqual } = require('../../src/utils/safeCompare.js');

function buildApp(SDK_API_KEY) {
    const app = express();
    app.use(bodyParser.json());
    app.use((req, res, next) => {
        let calls = Array.isArray(req.body) ? req.body : [req.body];
        let id = (Array.isArray(req.body) ? null : (req.body && req.body.id)) || null;
        let needsAuth = calls.some(call => {
            let method = call && call.method;
            return method && method.toLowerCase() !== 'ping';
        });
        if (needsAuth) {
            let header = req.headers['authorization'];
            let got = (typeof header === 'string' && header.startsWith('Bearer ')) ? header.slice(7) : null;
            if (!SDK_API_KEY || !safeTokenEqual(got, SDK_API_KEY)) {
                return res.status(401).json({
                    jsonrpc: '2.0', id,
                    error: { code: -32001, message: 'Unauthorized' }
                });
            }
        }
        next();
    });
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

    it('src/api.js wires safeTokenEqual into the auth gate before the jsonRouter mount', () => {
        const src = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8');
        const requireIdx = src.indexOf("require('./utils/safeCompare.js')");
        const gateIdx = src.indexOf('safeTokenEqual(got, SDK_API_KEY)');
        const routerIdx = src.indexOf('jsonRouter(');
        assert.notStrictEqual(requireIdx, -1, 'safeCompare require missing from src/api.js');
        assert.notStrictEqual(gateIdx, -1, 'safeTokenEqual call missing from the auth gate');
        assert.ok(gateIdx < routerIdx, 'auth gate must be registered before the jsonRouter mount');
    });
});
