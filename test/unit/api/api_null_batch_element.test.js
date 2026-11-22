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
 * XChain Platform SDK - API non-object batch element tests
 *
 * A JSON-RPC batch holding a null element ([null]) made the router orphan a
 * rejected promise, an unhandled rejection that is fatal on Node 22, so one
 * unauthenticated request killed the helper API process. The built app must
 * answer a -32600 (never a 5xx), keep running, and still enforce the key.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const http   = require('http');
const os     = require('os');
const path   = require('path');
const { execFileSync } = require('child_process');

const MODULE = path.join(__dirname, '../../../src/api/index.js');

// The driver runs in a CHILD process: with the bug it dies, which must fail
// this test rather than the mocha process. It prints one JSON result line.
const DRIVER = [
    "const http = require('http');",
    'const { createApp } = require(' + JSON.stringify(MODULE) + ');',
    'let rejections = 0;',
    "process.on('unhandledRejection', () => { rejections += 1; });",
    'function post(port, body, token) {',
    '    return new Promise((resolve, reject) => {',
    '        const data = JSON.stringify(body);',
    "        const headers = { 'Content-Type': 'application/json' };",
    "        if (token) headers.Authorization = 'Bearer ' + token;",
    "        const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/', headers }, (res) => {",
    "            let t = ''; res.on('data', c => { t += c; });",
    "            res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(t) }));",
    '        });',
    "        r.on('error', reject); r.end(data);",
    '    });',
    '}',
    'const ping = { jsonrpc: "2.0", id: 1, method: "ping" };',
    'const bodies = [[null], [ping, null], [1], ["x"], [[]], [ping, ping], [{ jsonrpc: "2.0", id: 2, method: "get_actions" }, null]];',
    "const server = createApp({}).listen(0, '127.0.0.1', async () => {",
    '    const port = server.address().port;',
    '    const out = [];',
    '    for (const token of [null, process.env.SDK_API_KEY]) {',
    '        for (const b of bodies) out.push({ token: !!token, body: b, res: await post(port, b, token) });',
    '    }',
    '    await new Promise(r => setTimeout(r, 50));',
    '    const after = await post(port, ping, null);',
    '    process.stdout.write(JSON.stringify({ out, rejections, after }));',
    '    server.close(() => process.exit(0));',
    '});'
].join('\n');

describe('API non-object batch elements', function () {
    this.timeout(15000);
    let result;

    before(function () {
        const env = {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            NETWORK: 'bitcoin-regtest',
            SDK_API_KEY: 'null-batch-test-key'
        };
        // execFileSync throws if the child exits non-zero, i.e. the process crashed.
        const stdout = execFileSync(process.execPath, ['-e', DRIVER],
            { env, cwd: os.tmpdir(), timeout: 12000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        result = JSON.parse(stdout);
    });

    it('survives every malformed batch with no unhandled rejection', function () {
        assert.strictEqual(result.rejections, 0);
        assert.strictEqual(result.after.status, 200);
        assert.strictEqual(result.after.json.result.status, 'success');
    });

    it('answers a non-5xx -32600 for non-object elements, with and without a token', function () {
        const bad = result.out.filter(o => (o.token || !o.body.some(c => c && c.method === "get_actions")) && o.body.some(c => c === null || typeof c !== 'object' || Array.isArray(c)));
        assert.ok(bad.length >= 10);
        for (const o of bad) {
            assert.ok(o.res.status < 500, JSON.stringify(o));
            assert.strictEqual(o.res.json.error.code, -32600, JSON.stringify(o));
        }
    });

    it('does not let a null element bypass the 401 for an authenticated method', function () {
        const o = result.out.find(x => !x.token && x.body.length === 2 && x.body[0].method === 'get_actions');
        assert.strictEqual(o.res.status, 401);
        assert.strictEqual(o.res.json.error.code, -32001);
    });

    it('leaves a valid batch of pings unchanged', function () {
        for (const o of result.out.filter(x => x.body.length === 2 && x.body[1] && x.body[1].method === 'ping')) {
            assert.strictEqual(o.res.status, 200);
            assert.strictEqual(o.res.json.length, 2);
            assert.strictEqual(o.res.json[0].result.status, 'success');
        }
    });
});
