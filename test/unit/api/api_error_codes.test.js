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
 * XChain SDK tests - JSON-RPC error responses carry integer codes
 *
 * JSON-RPC 2.0 requires error.code to be an integer. The router answers
 * Number(err.code || err.status || -32603), and SDK errors carry a string code
 * ('MISSING_ACTION'), so they went out as code null. Handlers also read
 * params.x with no shape check, so params null answered -32603 with the
 * TypeError text, and upstream failures echoed the explorer host:port. The
 * built app runs in a CHILD process (settings are read at require time) and is
 * driven over HTTP with a stub sdk whose failures mirror the real clients.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const os     = require('os');
const path   = require('path');
const { execFileSync } = require('child_process');

const MODULE = path.join(__dirname, '../../../src/api/index.js');
const ERRORS = path.join(__dirname, '../../../src/utils/errors.js');
const KEY = 'error-codes-test-key';

// [label, method, params] rows; OMIT drops the params member (JSON.stringify would turn undefined into null).
const OMIT = '<omit>';
const CALLS = [
    ['create_action:null', 'create_action', null],
    ['create_action:string', 'create_action', 'SEND'],
    ['create_action:array', 'create_action', ['SEND']],
    ['create_action:number', 'create_action', 7],
    ['create_action:missing', 'create_action', OMIT],
    ['create_action:no-action', 'create_action', { version: 0 }],
    ['get_status', 'get_status', OMIT],
    ['get_balances:upstream', 'get_balances', { address: 'x' }],
    ['get_market:null', 'get_market', null],
    ['get_token:typeerror', 'get_token', { tick: 'X' }],
    ['get_actions:rate', 'get_actions', []],
    ['get_markets:null', 'get_markets', null],
    ['ping:array', 'ping', []],
    ['get_market:ok', 'get_market', { tick1: 'A', tick2: 'B' }]
];

const SCRIPT = [
    "const http = require('http');",
    'const { createApp } = require(' + JSON.stringify(MODULE) + ');',
    'const E = require(' + JSON.stringify(ERRORS) + ');',
    // Mirrors the real failures: src/actions/index.js MISSING_ACTION, the explorer
    // transport EXPLORER_NETWORK text, and a TypeError from deep inside a call.
    'const sdk = {',
    "  async createAction(p) { if (!p || !p.action) throw new E.SDKValidationError('MISSING_ACTION', 'Request must include an action field'); return { ok: true }; },",
    "  async getStatus() { throw new E.SDKExplorerError('EXPLORER_NETWORK', 'Explorer request failed: connect ECONNREFUSED 127.0.0.1:9', { url: 'http://127.0.0.1:9/BTC/api/status' }); },",
    "  async getBalances() { throw new E.SDKEncoderError('ENCODER_NETWORK', 'Encoder request failed: connect ECONNREFUSED 127.0.0.1:9'); },",
    "  async getToken() { throw new TypeError(\"Cannot read properties of undefined (reading 'tick1')\"); },",
    "  async getActions() { throw new E.SDKRateLimitedError('explorer at 127.0.0.1:9 rate limited', { retryAfterSeconds: 5 }); },",
    "  async getMarkets(t) { return { markets: [], tick: t === undefined ? null : t }; },",
    "  async getMarket(a, b) { return { pair: a + '/' + b }; }",
    '};',
    'const app = createApp(sdk);',
    'const server = http.createServer(app);',
    "server.listen(0, '127.0.0.1', async () => {",
    '  const port = server.address().port;',
    '  const out = {};',
    '  async function post(body) {',
    "    const headers = { 'content-type': 'application/json', authorization: 'Bearer ' + " + JSON.stringify(KEY) + ' };',
    "    const res = await fetch('http://127.0.0.1:' + port + '/', { method: 'POST', headers, body: JSON.stringify(body) });",
    '    return { status: res.status, body: await res.json() };',
    '  }',
    '  try {',
    '    for (const [label, method, params] of ' + JSON.stringify(CALLS) + ') {',
    "      const body = { jsonrpc: '2.0', id: 1, method };",
    '      if (params !== ' + JSON.stringify(OMIT) + ') body.params = params;',
    '      out[label] = await post(body);',
    '    }',
    "    out.batch = await post([{ jsonrpc: '2.0', id: 1, method: 'create_action', params: null },",
    "      { jsonrpc: '2.0', id: 2, method: 'get_status' }, { jsonrpc: '2.0', id: 3, method: 'ping' }]);",
    '  } finally { server.close(); }',
    '  process.stdout.write(JSON.stringify(out));',
    '  process.exit(0);',
    '});'
].join('\n');

// One child run serves every describe block below.
let out;
function load() {
    if (out) return;
    const env = { PATH: process.env.PATH, HOME: process.env.HOME,
        NETWORK: 'bitcoin-regtest', SDK_API_KEY: KEY };
    out = JSON.parse(execFileSync(process.execPath, ['-e', SCRIPT],
        { env, cwd: os.tmpdir(), timeout: 15000, encoding: 'utf8' }));
}

function errorOf(label) {
    const r = out[label];
    assert.ok(r && r.body && r.body.error, label + ': ' + JSON.stringify(r));
    return r.body.error;
}

describe('API JSON-RPC error codes are integers', function () {
    this.timeout(20000);
    before(load);

    it('every error response, single and batched, has an integer code', () => {
        const errors = [];
        for (const [label] of CALLS)
            if (out[label].body.error) errors.push([label, out[label].body.error]);
        for (const item of out.batch.body)
            if (item.error) errors.push(['batch:' + item.id, item.error]);
        assert.ok(errors.length >= 10, 'expected the failing rows to answer errors');
        for (const [label, e] of errors) {
            assert.ok(Number.isInteger(e.code), label + ': ' + JSON.stringify(e));
            assert.notStrictEqual(JSON.stringify(e.code), 'null', label);
        }
    });

    for (const label of ['create_action:null', 'create_action:string', 'create_action:array', 'create_action:number']) {
        it(label + ' params answers -32602 before the handler reads them', () => {
            const e = errorOf(label);
            assert.strictEqual(e.code, -32602, JSON.stringify(e));
            assert.ok(!/Cannot read properties/.test(e.message), e.message);
        });
    }

    for (const label of ['create_action:missing', 'create_action:no-action']) {
        it(label + ' answers -32602 with the SDK message and its string code in data', () => {
            const e = errorOf(label);
            assert.strictEqual(e.code, -32602, JSON.stringify(e));
            assert.strictEqual(e.message, 'Request must include an action field');
            assert.deepStrictEqual(e.data, { code: 'MISSING_ACTION' });
        });
    }
});

describe('API JSON-RPC upstream and unexpected errors hide internal text', function () {
    this.timeout(20000);
    before(load);

    it('get_status with an unreachable explorer answers an integer code and no host, port or socket text', () => {
        const e = errorOf('get_status');
        assert.strictEqual(e.code, -32000, JSON.stringify(e));
        assert.strictEqual(e.data.code, 'EXPLORER_NETWORK');
        const text = JSON.stringify(e);
        assert.ok(!text.includes('127.0.0.1') && !text.includes('ECONNREFUSED') && !text.includes(':9'), text);
    });

    it('an encoder failure answers the same way', () => {
        const e = errorOf('get_balances:upstream');
        assert.strictEqual(e.code, -32000, JSON.stringify(e));
        const text = JSON.stringify(e);
        assert.ok(!text.includes('127.0.0.1') && !text.includes('ECONNREFUSED'), text);
    });

    it('a rate-limited upstream answers an integer code with its wait in data', () => {
        const e = errorOf('get_actions:rate');
        assert.strictEqual(e.code, -32000, JSON.stringify(e));
        assert.deepStrictEqual(e.data, { code: 'RATE_LIMITED', retryAfterSeconds: 5 });
        assert.ok(!JSON.stringify(e).includes('127.0.0.1'));
    });

    it('get_market with params null answers -32602, never the TypeError text', () => {
        const e = errorOf('get_market:null');
        assert.strictEqual(e.code, -32602, JSON.stringify(e));
        assert.ok(!/Cannot read properties|tick1/.test(e.message), e.message);
    });

    it('an unexpected exception answers -32603 Internal error with no internal text', () => {
        const e = errorOf('get_token:typeerror');
        assert.strictEqual(e.code, -32603, JSON.stringify(e));
        assert.strictEqual(e.message, 'Internal error');
        assert.ok(!JSON.stringify(e).includes('tick1'));
    });
});

describe('API JSON-RPC params check keeps valid calls working', function () {
    this.timeout(20000);
    before(load);

    it('a params-free method ignores params, and get_markets still accepts null', () => {
        assert.deepStrictEqual(out['ping:array'].body.result, { status: 'success' });
        assert.deepStrictEqual(out['get_markets:null'].body.result, { markets: [], tick: null });
        assert.deepStrictEqual(out['get_market:ok'].body.result, { pair: 'A/B' });
    });

    it('a batch answers per-element integer codes beside a success', () => {
        const byId = Object.fromEntries(out.batch.body.map((x) => [x.id, x]));
        assert.strictEqual(byId[1].error.code, -32602);
        assert.strictEqual(byId[2].error.code, -32000);
        assert.deepStrictEqual(byId[3].result, { status: 'success' });
    });
});
