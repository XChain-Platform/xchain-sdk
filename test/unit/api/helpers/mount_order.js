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
 * XChain SDK tests - runtime middleware mount order
 *
 * Reads the handler names of the app createApp() builds, in the order Express
 * runs them. Guard-order tests assert on this rather than on byte offsets in
 * src/api/index.js, because a guard mounted inside a helper runs where the
 * helper is CALLED, which the source text does not show.
 *
 * The module runs in a CHILD process with a fixed environment and a neutral
 * cwd, as api_listener.test.js does: it reads settings at require time and
 * dotenv.config() would otherwise load a repo-root .env into the mocha process.
 *
 ********************************************************************/

'use strict';

const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const MODULE = path.join(__dirname, '../../../../src/api/index.js');

// Name the JSON-RPC dispatch layer: express-json-rpc-router returns an anonymous handler.
const DISPATCH_NAME = 'jsonRpcDispatch';

const STACK_SCRIPT = [
    "const Module = require('module');",
    'const realLoad = Module._load;',
    'Module._load = function (request) {',
    '    const loaded = realLoad.apply(this, arguments);',
    "    if (request !== 'express-json-rpc-router') return loaded;",
    '    return function () {',
    '        const handler = loaded.apply(this, arguments);',
    '        return { ' + DISPATCH_NAME + '(req, res, next) { return handler(req, res, next); } }.' + DISPATCH_NAME + ';',
    '    };',
    '};',
    'const { createApp } = require(' + JSON.stringify(MODULE) + ');',
    'const stack = createApp({}).router.stack;',
    "process.stdout.write(JSON.stringify(stack.map(l => (l.handle && l.handle.name) || '')));"
].join('\n');

// Return createApp's layer handler names in runtime order ('' for an anonymous layer).
function builtMountOrder() {
    const env = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NETWORK: 'bitcoin-regtest',
        SDK_API_KEY: 'mount-order-test-key'
    };
    const out = execFileSync(process.execPath, ['-e', STACK_SCRIPT],
        { env, cwd: os.tmpdir(), timeout: 8000, encoding: 'utf8' });
    return JSON.parse(out);
}

// Return the runtime index of each named layer, asserting every one is mounted exactly once.
function mountIndexes(assert, names) {
    const order = builtMountOrder();
    const found = {};
    for (const name of names) {
        const first = order.indexOf(name);
        assert.notStrictEqual(first, -1, name + ' is not mounted on the built app: ' + JSON.stringify(order));
        assert.strictEqual(order.lastIndexOf(name), first, name + ' is mounted twice: ' + JSON.stringify(order));
        found[name] = first;
    }
    return found;
}

module.exports = { builtMountOrder, mountIndexes, DISPATCH_NAME };
