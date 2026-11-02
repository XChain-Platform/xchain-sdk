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
 * XChain Platform SDK - API malformed body: response and log volume
 *
 * A body-parser SyntaxError that falls through to Express's default handler
 * answers an HTML page with the stack AND writes that stack to stderr once per
 * request, so an anonymous caller sets the log rate. The shipped app must answer
 * a JSON-RPC parse error and write nothing to stderr for a malformed body, with
 * NODE_ENV unset (the shipped container sets none).
 *
 * Runs in a CHILD process (settings are read at require time), capturing the
 * child's stderr and stdout.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const os     = require('os');
const path   = require('path');
const { spawnSync } = require('child_process');

const MODULE = path.join(__dirname, '../../../src/api/index.js');

const SCRIPT = [
    "const http = require('http');",
    "const { createApp } = require(process.env.API_MODULE);",
    "const server = http.createServer(createApp({}));",
    "function post(port, body, headers) { return new Promise((resolve, reject) => {",
    "  const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/',",
    "    headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, headers) }, (res) => {",
    "    let t = ''; res.setEncoding('utf8'); res.on('data', (c) => { t += c; });",
    "    res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '', text: t }));",
    "  }); req.on('error', reject); req.end(body); }); }",
    "server.listen(0, '127.0.0.1', async () => {",
    "  const out = { bad: [], big: null, ok: null };",
    "  try {",
    "    const port = server.address().port;",
    "    for (let i = 0; i < 20; i++) out.bad.push(await post(port, '{\"method\":'));",
    "    out.big = await post(port, JSON.stringify({ method: 'ping', pad: 'x'.repeat(101 * 1024) }));",
    "    out.ok = await post(port, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }));",
    "  } finally { server.close(); }",
    "  process.stdout.write(JSON.stringify(out));",
    "});"
].join('\n');

describe('API malformed body answers JSON and logs no stack', function () {
    this.timeout(30000);
    let out, stderr;
    before(() => {
        const env = { PATH: process.env.PATH, HOME: process.env.HOME, NETWORK: 'bitcoin-regtest',
                      SDK_API_KEY: 'parse-json-test-key', API_MODULE: MODULE };
        const r = spawnSync(process.execPath, ['-e', SCRIPT],
            { env, cwd: os.tmpdir(), encoding: 'utf8', timeout: 20000 });
        assert.strictEqual(r.status, 0, r.stderr);
        out = JSON.parse(r.stdout);
        stderr = r.stderr;
    });

    it('answers every malformed body 400 with a JSON-RPC -32700 envelope', () => {
        assert.strictEqual(out.bad.length, 20);
        for (const r of out.bad) {
            assert.strictEqual(r.status, 400);
            assert.match(r.type, /application\/json/);
            const body = JSON.parse(r.text);
            assert.strictEqual(body.jsonrpc, '2.0');
            assert.strictEqual(body.id, null);
            assert.strictEqual(body.error.code, -32700);
            assert.doesNotMatch(r.text, /SyntaxError|node_modules| at /);
        }
    });

    it('answers an oversize body 413 as JSON', () => {
        assert.strictEqual(out.big.status, 413);
        assert.match(out.big.type, /application\/json/);
        assert.strictEqual(JSON.parse(out.big.text).jsonrpc, '2.0');
    });

    it('writes no stack trace to stderr for 20 malformed requests', () => {
        assert.doesNotMatch(stderr, /SyntaxError|node_modules|\n\s+at /);
        assert.ok(stderr.length < 2000, 'stderr grew with the request count: ' + stderr.length + ' bytes');
    });

    it('still lets a valid request reach the router', () => {
        assert.strictEqual(out.ok.status, 200);
        assert.deepStrictEqual(JSON.parse(out.ok.text).result, { status: 'success' });
    });
});
