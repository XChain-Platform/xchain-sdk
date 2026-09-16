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
 * XChain Platform SDK - API listener tests
 *
 * src/api/index.js used to call startApi() at module scope, so a require() of
 * it opened a socket on SDK_API_PORT as a side effect and no consumer could
 * mount the app or start the server on its own terms. These tests pin the
 * shape that replaced it: the module exports createApp and startApi, a plain
 * require() opens nothing, startApi() opens a listener the caller owns, and
 * the CLI entry (`npm run api`) still listens on SDK_API_PORT at load.
 *
 * Every case runs the module in a CHILD process: the module reads its
 * settings from the environment at require time and dotenv.config() would
 * load a repo-root .env into this mocha process, so a child with a fixed
 * environment and a neutral cwd is the only way to drive it deterministically
 * and leave the suite's process untouched.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const http   = require('http');
const net    = require('net');
const os     = require('os');
const path   = require('path');
const { spawn, execFile } = require('child_process');

const MODULE = path.join(__dirname, '../../../src/api/index.js');

// A fixed environment for every child: a regtest network so the SDK asks no
// public hub for discovery, a key so the gate does not warn, and nothing
// inherited that could point the child at a live service.
function childEnv(extra = {}) {
    return Object.assign({
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NETWORK: 'bitcoin-regtest',
        SDK_API_KEY: 'listener-test-key'
    }, extra);
}

// A port the OS hands out and releases: the entry case must be told its port
// through SDK_API_PORT before it starts, so 0 cannot be used there.
function freePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

// One JSON-RPC ping against the listener, resolved with the parsed body.
function postPing(port) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 });
        const req = http.request({
            host: '127.0.0.1', port, method: 'POST', path: '/',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { text += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
        });
        req.on('error', reject);
        req.end(body);
    });
}

// Resolves true when something accepts a TCP connection on the port.
function portAnswers(port) {
    return new Promise((resolve) => {
        const sock = net.connect(port, '127.0.0.1');
        sock.once('connect', () => { sock.end(); resolve(true); });
        sock.once('error', () => resolve(false));
    });
}

// Runs a script in a fresh node with the fixed environment and a neutral cwd.
function runScript(script, env) {
    return new Promise((resolve) => {
        execFile(process.execPath, ['-e', script], { env, cwd: os.tmpdir(), timeout: 8000 },
            (err, stdout, stderr) => resolve({ err, stdout, stderr }));
    });
}

// Collects a child's stdout until `marker` appears, then resolves with the text.
function waitForOutput(child, marker) {
    return new Promise((resolve, reject) => {
        let text = '';
        const onData = (chunk) => {
            text += chunk;
            if (text.includes(marker)) { child.stdout.off('data', onData); resolve(text); }
        };
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', onData);
        child.once('exit', (code) => reject(new Error('child exited ' + code + ' before "' + marker + '": ' + text)));
    });
}

// The require case, run in a child: count every listen() the require issues,
// then print what the module exported. The child must also EXIT on its own,
// since a socket left open would keep it alive past execFile's timeout.
const REQUIRE_SCRIPT = [
    "const net = require('net'); let listens = 0;",
    'const real = net.Server.prototype.listen;',
    'net.Server.prototype.listen = function () { listens += 1; return real.apply(this, arguments); };',
    'const mod = require(' + JSON.stringify(MODULE) + ');',
    'process.stdout.write(JSON.stringify({ listens, keys: Object.keys(mod).sort(),',
    '    createApp: typeof mod.createApp, startApi: typeof mod.startApi }));'
].join('\n');

// The startApi case: the child reports its ephemeral port once listening,
// closes the server when its stdin ends, and exits 0 only through that close.
const START_SCRIPT = [
    'const { startApi } = require(' + JSON.stringify(MODULE) + ');',
    'startApi({ port: 0 }).then((server) => {',
    "    const report = () => process.stdout.write('PORT ' + server.address().port + '\\n');",
    "    if (server.listening) report(); else server.once('listening', report);",
    "    process.stdin.on('end', () => server.close(() => process.exit(0)));",
    '    process.stdin.resume();',
    '});'
].join('\n');

// Spawns node with the fixed environment, collecting stderr and the exit code.
function spawnChild(args, env, stdin) {
    const child = spawn(process.execPath, args,
        { env, cwd: os.tmpdir(), stdio: [stdin, 'pipe', 'pipe'] });
    const errText = [];
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => errText.push(chunk));
    const exit = new Promise((resolve) => child.once('exit', resolve));
    return { child, exit, stderr: () => errText.join('') };
}

describe('API listener is explicit', function () {
    this.timeout(15000);

    describe('require(src/api/index.js)', () => {
        it('opens no listener and exports createApp and startApi', async () => {
            const { err, stdout, stderr } = await runScript(REQUIRE_SCRIPT, childEnv({ SDK_API_PORT: '0' }));
            assert.ifError(err && new Error('child failed: ' + (err.killed ? 'timed out (a listener kept it alive)' : err.message) + '\n' + stderr));
            const out = JSON.parse(stdout);
            assert.strictEqual(out.listens, 0, 'require() must not call listen()');
            assert.deepStrictEqual(out.keys, ['createApp', 'startApi']);
            assert.strictEqual(out.createApp, 'function');
            assert.strictEqual(out.startApi, 'function');
        });
    });

    describe('startApi({ port: 0 })', () => {
        it('opens a listener that answers ping, and server.close() releases it', async () => {
            const { child, exit, stderr } = spawnChild(['-e', START_SCRIPT], childEnv(), 'pipe');
            try {
                const text = await waitForOutput(child, 'PORT ');
                const port = Number(/PORT (\d+)/.exec(text)[1]);
                assert.ok(port > 0, 'startApi must resolve to a listening server');
                const res = await postPing(port);
                assert.strictEqual(res.status, 200);
                assert.deepStrictEqual(res.body.result, { status: 'success' });
                child.stdin.end();
                assert.strictEqual(await exit, 0, 'the child must exit through server.close(): ' + stderr());
                assert.strictEqual(await portAnswers(port), false, 'the port must be released after close()');
            } finally {
                if (child.exitCode === null) child.kill();
            }
        });
    });

    describe('node src/api/index.js as the entry', () => {
        it('listens on SDK_API_PORT at load and logs the listening line', async () => {
            const port = await freePort();
            const { child, exit } = spawnChild([MODULE], childEnv({ SDK_API_PORT: String(port) }), 'ignore');
            try {
                const text = await waitForOutput(child, 'SDK API listening on port ' + port);
                assert.ok(text.includes('SDK API listening on port ' + port));
                const res = await postPing(port);
                assert.strictEqual(res.status, 200);
                assert.deepStrictEqual(res.body.result, { status: 'success' });
            } finally {
                child.kill();
                await exit;
            }
        });
    });
});
