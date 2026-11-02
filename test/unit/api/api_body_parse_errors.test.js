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
 * XChain Platform SDK - API body parse errors
 *
 * Invalid JSON, a non-object body and an oversize body fail inside body-parser,
 * ahead of the router. Express's default handler answers those with an HTML page
 * that carries the stack and absolute paths outside production. The shipped app
 * must answer a JSON-RPC error envelope in either NODE_ENV and leak nothing.
 *
 * The app runs in a CHILD process with a fixed environment and a neutral cwd,
 * as api_listener.test.js does, because the module reads settings at require
 * time and dotenv.config() would otherwise load a repo-root .env.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const os     = require('os');
const path   = require('path');
const { execFileSync } = require('child_process');

const MODULE = path.join(__dirname, '../../../src/api/index.js');

const SCRIPT = [
    "const http = require('http');",
    "const { createApp } = require(process.env.API_MODULE);",
    "const server = http.createServer(createApp({}));",
    "const bodies = ['{', 'null', '\"str\"', JSON.stringify({ method: 'ping', pad: 'x'.repeat(101 * 1024) })];",
    "function post(port, body) { return new Promise((resolve, reject) => {",
    "  const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/',",
    "    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {",
    "    let t = ''; res.setEncoding('utf8'); res.on('data', (c) => { t += c; });",
    "    res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '', text: t }));",
    "  }); req.on('error', reject); req.end(body); }); }",
    "server.listen(0, '127.0.0.1', async () => {",
    "  const out = [];",
    "  try { for (const b of bodies) out.push(await post(server.address().port, b)); }",
    "  finally { server.close(); }",
    "  process.stdout.write(JSON.stringify(out));",
    "});"
].join('\n');

function run(nodeEnv) {
    const env = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NETWORK: 'bitcoin-regtest',
        SDK_API_KEY: 'body-parse-test-key',
        API_MODULE: MODULE
    };
    if (nodeEnv !== undefined) env.NODE_ENV = nodeEnv;
    return JSON.parse(execFileSync(process.execPath, ['-e', SCRIPT],
        { env, cwd: os.tmpdir(), encoding: 'utf8', timeout: 20000 }));
}

const LEAK = /<html|<pre|at .*\(|\/Users\/|\/private\/|node_modules/;

for (const [label, nodeEnv] of [['NODE_ENV unset', undefined], ['NODE_ENV=production', 'production']]) {
    describe('API body parse errors (' + label + ')', function () {
        this.timeout(30000);
        let results;
        before(() => { results = run(nodeEnv); });

        ['invalid JSON', 'null body', 'string body', 'oversize body'].forEach((name, i) => {
            it(name + ' answers a JSON-RPC error with no stack or path', () => {
                const r = results[i];
                assert.strictEqual(r.status, name === 'oversize body' ? 413 : 400);
                assert.match(r.type, /application\/json/);
                const body = JSON.parse(r.text);
                assert.strictEqual(typeof body, 'object');
                assert.ok(body.error && typeof body.error.message === 'string');
                assert.strictEqual(body.jsonrpc, '2.0');
                assert.ok(!('stack' in body) && !('stack' in body.error));
                assert.doesNotMatch(r.text, LEAK);
            });
        });
    });
}
