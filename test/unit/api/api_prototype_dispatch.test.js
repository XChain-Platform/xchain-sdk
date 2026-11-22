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
 *
 * XChain SDK tests - JSON-RPC dispatch ignores inherited Object.prototype names
 *
 * express-json-rpc-router validates a method with `method in controller`, which
 * is true for inherited members, so `constructor`, `toString` and friends
 * dispatched for an authenticated caller (constructor echoed its params, others
 * answered 200 with a wrong error code). The controller must own only its real
 * methods. The built app runs in a CHILD process (settings are read at require
 * time) and is driven over HTTP with a stub sdk.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const os     = require('os');
const path   = require('path');
const { execFileSync } = require('child_process');

const MODULE = path.join(__dirname, '../../../src/api/index.js');
const KEY = 'proto-dispatch-test-key';
const NAMES = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__',
    '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__',
    'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString'];

const SCRIPT = [
    "const http = require('http');",
    'const { createApp } = require(' + JSON.stringify(MODULE) + ');',
    'const app = createApp({});',
    'const server = http.createServer(app);',
    "server.listen(0, '127.0.0.1', async () => {",
    '  const port = server.address().port;',
    '  const out = {};',
    '  async function post(auth, method) {',
    "    const headers = { 'content-type': 'application/json' };",
    "    if (auth) headers.authorization = 'Bearer ' + " + JSON.stringify(KEY) + ';',
    "    const res = await fetch('http://127.0.0.1:' + port + '/', { method: 'POST', headers,",
    "      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { echo: 'me' } }) });",
    '    return { status: res.status, body: await res.json() };',
    '  }',
    '  try {',
    '    for (const m of ' + JSON.stringify(NAMES) + ') {',
    "      out['auth:' + m] = await post(true, m);",
    "      out['anon:' + m] = await post(false, m);",
    '    }',
    "    out.ping = await post(true, 'ping');",
    '  } finally { server.close(); }',
    '  process.stdout.write(JSON.stringify(out));',
    '  process.exit(0);',
    '});'
].join('\n');

describe('API JSON-RPC prototype member dispatch', function () {
    this.timeout(20000);
    let out;
    before(() => {
        const env = { PATH: process.env.PATH, HOME: process.env.HOME,
            NETWORK: 'bitcoin-regtest', SDK_API_KEY: KEY };
        out = JSON.parse(execFileSync(process.execPath, ['-e', SCRIPT],
            { env, cwd: os.tmpdir(), timeout: 15000, encoding: 'utf8' }));
    });

    for (const m of NAMES) {
        it('authenticated ' + m + ' answers -32601 and no result', () => {
            const r = out['auth:' + m];
            assert.ok(r.body.error, JSON.stringify(r));
            assert.strictEqual(r.body.error.code, -32601, JSON.stringify(r));
            assert.ok(!('result' in r.body), JSON.stringify(r));
        });
        it('unauthenticated ' + m + ' still answers 401 / -32001', () => {
            const r = out['anon:' + m];
            assert.strictEqual(r.status, 401, JSON.stringify(r));
            assert.strictEqual(r.body.error.code, -32001, JSON.stringify(r));
        });
    }

    it('a real method still dispatches', () => {
        assert.deepStrictEqual(out.ping.body.result, { status: 'success' });
    });
});
