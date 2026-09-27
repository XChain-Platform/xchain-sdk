// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Covers scripts/cosigner-init-window.js. The script does its work at module
// load and calls process.exit directly, so it is run as a child process from a
// throwaway directory.
//
// Not wired into `npm test`; run directly with:
//   npx mocha --timeout 10000 scripts/cosigner-init-window.check.test.js

'use strict';

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'cosigner-init-window.js');

function run(...args) {
    return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd: tmpDir });
}

let tmpDir;

describe('cosigner-init-window CLI', () => {
    before(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosigner-init-window-'));
    });

    after(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('exits 2 with a usage line when given no arguments', () => {
        const r = run();
        assert.strictEqual(r.status, 2);
        assert.match(r.stderr, /usage:/);
    });

    it('exits 2 when windowHours is missing', () => {
        const r = run(path.join(tmpDir, 'missing-hours.json'));
        assert.strictEqual(r.status, 2);
        assert.match(r.stderr, /usage:/);
    });

    for (const bad of ['abc', '0', '-5', 'NaN', 'Infinity']) {
        it(`exits 2 for windowHours "${bad}" and creates nothing`, () => {
            const file = path.join(tmpDir, `bad-${bad}.json`);
            const r = run(file, bad);
            assert.strictEqual(r.status, 2);
            assert.match(r.stderr, /windowHours must be a positive number/);
            assert.strictEqual(fs.existsSync(file), false);
        });
    }

    describe('with a valid state file', () => {
        let file;
        let first;
        let snapshot;

        before(() => {
            file = path.join(tmpDir, 'window.json');
            first = run(file, '24');
            if (fs.existsSync(file)) snapshot = { content: fs.readFileSync(file, 'utf8'), mtimeMs: fs.statSync(file).mtimeMs };
        });

        it('exits 0 and reports the created window', () => {
            assert.strictEqual(first.status, 0, first.stderr);
            assert.match(first.stdout, /created an empty 24h co-signer spending window/);
            assert.ok(first.stdout.includes(file));
        });

        it('leaves an empty window file and releases its lock', () => {
            assert.ok(snapshot, 'window file was not created');
            const parsed = JSON.parse(snapshot.content);
            assert.deepStrictEqual(parsed.entries, []);
            assert.ok(Number.isFinite(parsed.lastSeen) && parsed.lastSeen > 0);
            assert.deepStrictEqual(Object.keys(parsed).sort(), ['entries', 'lastSeen']);
            assert.strictEqual(fs.existsSync(`${file}.lock`), false);
        });

        (process.platform === 'win32' ? it.skip : it)('creates the file with mode 0600', () => {
            assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
        });

        it('refuses to overwrite the same file and leaves it untouched', () => {
            const again = run(file, '48');
            assert.strictEqual(again.status, 1);
            assert.match(again.stderr, /refusing to overwrite an existing window/);
            assert.strictEqual(fs.readFileSync(file, 'utf8'), snapshot.content);
            assert.strictEqual(fs.statSync(file).mtimeMs, snapshot.mtimeMs);
        });
    });
});
