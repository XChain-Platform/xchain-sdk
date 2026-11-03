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
 * XChain SDK tests - a NUMBER_FIELD sent as an unsafe JSON number is a
 * client error, not a server fault
 *
 * bodyParser.json() hands every HTTP caller's numbers to the SDK as JS doubles,
 * and setNumberFormats refuses one the parser may already have rounded (above
 * 2^53, or more than 15 significant digits). That refusal was a plain
 * RangeError, so the API answered -32603 'Internal error' and dropped the
 * guidance to send the amount as a decimal string, and validate_action threw
 * instead of reporting {valid:false}. The built app runs in a CHILD process
 * (settings are read at require time) over HTTP, with an sdk whose
 * createAction/validateAction are the real offline Actions object, so the real
 * setNumberFormats is on the path.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const os     = require('os');
const path   = require('path');
const { execFileSync } = require('child_process');

const MODULE  = path.join(__dirname, '../../../src/api/index.js');
const ACTIONS = path.join(__dirname, '../../../src/actions/index.js');
const CONFIG  = path.join(__dirname, '../../../src/config.js');
const UTILITY = path.join(__dirname, '../../../src/utils/utility.js');
const KEY = 'unsafe-number-test-key';

// Raw JSON number spellings: they are spliced into the request body text
// unquoted, exactly as a client would send them.
const UNSAFE = ['1e21', '9007199254740993', '1.0000000000000002', '123456789012345678901234567890'];
const BASES = {
    ORDER: '"give_tick":"^2","give_amount":"1","get_tick":"^3","get_amount":"1"',
    DISPENSER: '"give_tick":"^2","give_amount":"1","get_tick":"^3","get_amount":"1"'
};

// [label, rawBodyText] rows.
const CALLS = [];
for (const action of Object.keys(BASES)) {
    for (const raw of UNSAFE) {
        const params = '{' + BASES[action] + ',"expiration":' + raw + '}';
        CALLS.push(['create:' + action + ':' + raw,
            '{"jsonrpc":"2.0","id":1,"method":"create_action","params":{"action":"' + action + '","version":0,"params":' + params + '}}']);
        CALLS.push(['validate:' + action + ':' + raw,
            '{"jsonrpc":"2.0","id":1,"method":"validate_action","params":{"action":"' + action + '","params":' + params + '}}']);
    }
    for (const [tag, raw] of [['string', '"9007199254740993"'], ['safe', '1000']]) {
        const params = '{' + BASES[action] + ',"expiration":' + raw + '}';
        CALLS.push(['validate:' + action + ':' + tag,
            '{"jsonrpc":"2.0","id":1,"method":"validate_action","params":{"action":"' + action + '","params":' + params + '}}']);
        CALLS.push(['create:' + action + ':' + tag,
            '{"jsonrpc":"2.0","id":1,"method":"create_action","params":{"action":"' + action + '","version":0,"params":' + params + '}}']);
    }
}
CALLS.push(['batch',
    '[{"jsonrpc":"2.0","id":903,"method":"create_action","params":{"action":"ORDER","version":0,"params":{'
    + BASES.ORDER + ',"expiration":1e21}}},{"jsonrpc":"2.0","id":904,"method":"ping"}]']);

const SCRIPT = [
    "const http = require('http');",
    'const { createApp } = require(' + JSON.stringify(MODULE) + ');',
    'const Actions = require(' + JSON.stringify(ACTIONS) + ');',
    'const config = require(' + JSON.stringify(CONFIG) + ');',
    'const Utility = require(' + JSON.stringify(UTILITY) + ');',
    // The real compose and dry-run paths, with no ticker or address resolution,
    // so nothing reaches the network.
    "const actions = new Actions({ config: config.getConfig(), util: new Utility(), options: { network: 'bitcoin-regtest' } });",
    'const sdk = {',
    '  async createAction(data) { return actions.createAction(data); },',
    '  validateAction(action, params) { return actions.validateAction(action, params); }',
    '};',
    'const app = createApp(sdk);',
    'const server = http.createServer(app);',
    "server.listen(0, '127.0.0.1', async () => {",
    '  const port = server.address().port;',
    '  const out = {};',
    '  try {',
    '    for (const [label, body] of ' + JSON.stringify(CALLS) + ') {',
    "      const headers = { 'content-type': 'application/json', authorization: 'Bearer ' + " + JSON.stringify(KEY) + ' };',
    "      const res = await fetch('http://127.0.0.1:' + port + '/', { method: 'POST', headers, body });",
    '      out[label] = { status: res.status, body: await res.json() };',
    '    }',
    '  } finally { server.close(); }',
    '  process.stdout.write(JSON.stringify(out));',
    '  process.exit(0);',
    '});'
].join('\n');

let out;
function load() {
    if (out) return;
    const env = { PATH: process.env.PATH, HOME: process.env.HOME,
        NETWORK: 'bitcoin-regtest', SDK_API_KEY: KEY };
    out = JSON.parse(execFileSync(process.execPath, ['-e', SCRIPT],
        { env, cwd: os.tmpdir(), timeout: 15000, encoding: 'utf8' }));
}

describe('API answers an unsafe JSON number in a NUMBER_FIELD as invalid params', function () {
    this.timeout(20000);
    before(load);

    for (const action of Object.keys(BASES)) {
        for (const raw of UNSAFE) {
            it('create_action ' + action + ' 0 EXPIRATION ' + raw + ' is -32602 with the decimal-string guidance', () => {
                const r = out['create:' + action + ':' + raw];
                assert.strictEqual(r.status, 200);
                const err = r.body.error;
                assert.ok(err, JSON.stringify(r.body));
                assert.strictEqual(err.code, -32602, JSON.stringify(err));
                assert.notStrictEqual(err.message, 'Internal error');
                assert.match(err.message, /EXPIRATION/);
                assert.match(err.message, /send an amount of this size as a decimal string/);
                assert.ok(err.data && typeof err.data.code === 'string' && err.data.code.length > 0,
                    JSON.stringify(err));
            });

            it('validate_action ' + action + ' EXPIRATION ' + raw + ' reports valid:false instead of throwing', () => {
                const r = out['validate:' + action + ':' + raw];
                assert.strictEqual(r.status, 200);
                assert.strictEqual(r.body.error, undefined, JSON.stringify(r.body));
                const res = r.body.result;
                assert.strictEqual(res.valid, false, JSON.stringify(res));
                assert.ok(Array.isArray(res.errors) && res.errors.length > 0);
                const hit = res.errors.find(e => /EXPIRATION/.test(e.message));
                assert.ok(hit, JSON.stringify(res.errors));
                assert.match(hit.message, /decimal string/);
                assert.strictEqual(typeof hit.code, 'string');
                assert.strictEqual(hit.details.field, 'EXPIRATION');
            });
        }

        it(action + ': the same magnitude as a decimal string, and a safe number, still pass', () => {
            for (const tag of ['string', 'safe']) {
                const v = out['validate:' + action + ':' + tag];
                assert.strictEqual(v.body.error, undefined, tag + ' ' + JSON.stringify(v.body));
                assert.strictEqual(v.body.result.valid, true, tag + ' ' + JSON.stringify(v.body.result));
                const c = out['create:' + action + ':' + tag];
                assert.strictEqual(c.body.error, undefined, tag + ' ' + JSON.stringify(c.body));
                assert.strictEqual(typeof c.body.result.actionString, 'string');
            }
            assert.match(out['create:' + action + ':string'].body.result.actionString, /\|9007199254740993(\||$)/);
            assert.match(out['create:' + action + ':safe'].body.result.actionString, /\|1000(\||$)/);
        });
    }

    it('a batch element with an unsafe number answers -32602 and leaves its neighbour alone', () => {
        const r = out.batch;
        assert.ok(Array.isArray(r.body), JSON.stringify(r.body));
        const bad = r.body.find(e => e.id === 903);
        const ok  = r.body.find(e => e.id === 904);
        assert.ok(bad && bad.error, JSON.stringify(r.body));
        assert.strictEqual(bad.error.code, -32602);
        assert.match(bad.error.message, /decimal string/);
        assert.ok(ok && ok.result !== undefined, JSON.stringify(r.body));
    });
});
