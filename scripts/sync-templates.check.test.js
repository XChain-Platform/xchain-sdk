// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Covers the --check mode added to sync-templates.js: it must
// fail loudly when the embedded copy has drifted from a sibling
// xchain-contracts checkout, and stay quiet when it has not.
//
// Runs the real script as a child process against a throwaway sandbox tree
// (never against the real ../xchain-contracts sibling, so this never
// touches a file outside this fix's own surfaces) built fresh in os.tmpdir()
// under a mkdtemp'd directory, so a sibling xchain-contracts checkout is
// mimicked without depending on, or risking, the real one.
//
// Not wired into `npm test` (the unit glob and any new npm script live in
// package.json, outside this fix's surface jail); run directly with:
//   npx mocha scripts/sync-templates.check.test.js

'use strict';

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { spawnSync } = require('child_process');

const SCRIPT_SRC = path.join(__dirname, 'sync-templates.js');

function buildSandbox() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-templates-check-'));
    const sdkScripts = path.join(root, 'sdk', 'scripts');
    const sdkContract = path.join(root, 'sdk', 'src', 'contract');
    const contracts = path.join(root, 'xchain-contracts');
    fs.mkdirSync(sdkScripts, { recursive: true });
    fs.mkdirSync(sdkContract, { recursive: true });
    fs.mkdirSync(path.join(contracts, 'patterns'), { recursive: true });

    // The script resolves paths relative to its own location, so copying it
    // unmodified into the sandbox is what makes the sandbox real: the same
    // code under test, pointed at fixture siblings instead of the real ones.
    fs.copyFileSync(SCRIPT_SRC, path.join(sdkScripts, 'sync-templates.js'));

    for (const name of ['escrow', 'vesting', 'crowdsale', 'amm']) {
        fs.mkdirSync(path.join(contracts, name), { recursive: true });
        fs.writeFileSync(path.join(contracts, name, name + '.js'),
            '// fixture ' + name + ' template v1\nmodule.exports = {};\n');
    }
    fs.writeFileSync(path.join(contracts, 'patterns', 'guard.js'),
        '// fixture pattern\nmodule.exports = {};\n');

    return { root, sdkScripts, contracts };
}

function run(sdkScripts, args) {
    return spawnSync(process.execPath, [path.join(sdkScripts, 'sync-templates.js'), ...args],
        { encoding: 'utf8' });
}

describe('sync-templates.js --check', function () {

    let sandbox;

    beforeEach(function () { sandbox = buildSandbox(); });
    afterEach(function () { fs.rmSync(sandbox.root, { recursive: true, force: true }); });

    it('exits 0 with a skip message when no sibling xchain-contracts checkout exists', function () {
        fs.rmSync(sandbox.contracts, { recursive: true, force: true });
        const res = run(sandbox.sdkScripts, ['--check']);
        assert.strictEqual(res.status, 0, res.stdout + res.stderr);
        assert.ok(/skipping/.test(res.stdout), 'expected a skip message, got: ' + res.stdout);
    });

    it('exits 1 when the embed does not exist yet', function () {
        const res = run(sandbox.sdkScripts, ['--check']);
        assert.strictEqual(res.status, 1, res.stdout + res.stderr);
        assert.ok(/TEMPLATE DRIFT/.test(res.stderr), 'expected a drift error, got: ' + res.stderr);
    });

    it('exits 0 right after a real sync, and 1 once the canonical source drifts (falsified and restored)', function () {
        const gen = run(sandbox.sdkScripts, []);
        assert.strictEqual(gen.status, 0, gen.stdout + gen.stderr);

        const clean = run(sandbox.sdkScripts, ['--check']);
        assert.strictEqual(clean.status, 0, clean.stdout + clean.stderr);

        // Falsify: edit the canonical template without regenerating, exactly
        // the failure mode, and confirm --check goes red for it.
        const escrowFile = path.join(sandbox.contracts, 'escrow', 'escrow.js');
        const before = fs.readFileSync(escrowFile, 'utf8');
        fs.writeFileSync(escrowFile, before + '// drifted edit, sync not re-run\n');

        const drifted = run(sandbox.sdkScripts, ['--check']);
        assert.strictEqual(drifted.status, 1, 'expected --check to catch the drift: ' + drifted.stdout + drifted.stderr);
        assert.ok(/TEMPLATE DRIFT/.test(drifted.stderr));

        // Restore byte-exact and confirm the guard clears again.
        fs.writeFileSync(escrowFile, before);
        const restored = run(sandbox.sdkScripts, ['--check']);
        assert.strictEqual(restored.status, 0, restored.stdout + restored.stderr);
    });

});
