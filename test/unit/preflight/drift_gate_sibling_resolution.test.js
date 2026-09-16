'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// How the drift gate behaves when it cannot resolve an xchain-indexer checkout.
//
// This is the level above the per-check sites, and it is the one that was broken: every
// individual check fails closed, but the gate answered an unresolved checkout by printing
// "skipping the sibling checks" and exiting 0, having compared no handler at all. A
// dropped CI checkout step, a typo in XCHAIN_INDEXER_PATH and a handler directory renamed
// out from under the identity test were all reported as a clean single-repo run.
//
// Driven as spawned processes against real exit codes, because the exit code IS the
// contract: `npm run ci`, the GitHub job and the indexer-side gate all read it and nothing
// else. Asserting on a returned value would leave the wiring untested.

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SDK_ROOT = path.join(__dirname, '..', '..', '..');
const GATE = path.join(SDK_ROOT, 'bin', 'check-preflight-drift.js');

// Three roots under one temp base, one per outcome the gate must tell apart:
//   absentRoot      nothing at the path
//   notIndexerRoot  a directory that is not an indexer checkout
//   shapedRoot      carries src/actions/, so it RESOLVES and gets compared
function makeRoots() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-gate-resolve-'));
    const roots = {
        base,
        absentRoot: path.join(base, 'no-such-checkout'),
        notIndexerRoot: path.join(base, 'some-other-repo'),
        shapedRoot: path.join(base, 'shaped-indexer'),
    };
    fs.mkdirSync(path.join(roots.notIndexerRoot, 'src', 'handlers'), { recursive: true });
    fs.mkdirSync(path.join(roots.shapedRoot, 'src', 'actions'), { recursive: true });
    return roots;
}

// The ambient environment may already carry either variable (the platform checkout
// runs the gate with siblings present), so every case states the whole set it means.
function runGate(env) {
    const clean = { ...process.env };
    delete clean.XCHAIN_INDEXER_PATH;
    delete clean.XCHAIN_REQUIRE_SIBLINGS;
    delete clean.XCHAIN_ALLOW_NO_INDEXER;
    const r = spawnSync(process.execPath, [GATE], {
        cwd: SDK_ROOT,
        encoding: 'utf8',
        env: { ...clean, ...env },
    });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// Two blocks under one title, so every full test title reads as it did in one block: the
// first covers an unresolved checkout, the second the declarations that change the answer.
describe('drift gate sibling resolution (§8.5)', function () {
    this.timeout(20000);
    let roots;
    before(function () { roots = makeRoots(); });
    after(function () { if (roots) fs.rmSync(roots.base, { recursive: true, force: true }); });

    it('fails, rather than skipping, when no indexer checkout resolves', function () {
        const { absentRoot } = roots;
        const { code, out } = runGate({ XCHAIN_INDEXER_PATH: absentRoot });
        expect(code, 'exit code with no checkout').to.equal(1);
        expect(out, 'names what it looked for').to.include('src/actions');
        expect(out, 'names where it looked').to.include(absentRoot);
        expect(out, 'no longer claims a clean skip').to.not.include('skipping the sibling checks (sibling CI enforces)');
    });

    it('says a directory that is not an indexer checkout is a different fact from an absent one', function () {
        // The two need different fixes: check the sibling out, versus a layout this gate
        // no longer recognises. One message for both is how a rename reads as "no sibling".
        const absent = runGate({ XCHAIN_INDEXER_PATH: roots.absentRoot });
        const wrong = runGate({ XCHAIN_INDEXER_PATH: roots.notIndexerRoot });
        expect(wrong.code, 'exit code with an unidentifiable checkout').to.equal(1);
        expect(absent.out).to.include('no such directory');
        expect(wrong.out).to.include('the directory is there but holds no');
        expect(wrong.out).to.not.include('no such directory');
    });
});

describe('drift gate sibling resolution (§8.5)', function () {
    this.timeout(20000);
    let roots;
    before(function () { roots = makeRoots(); });
    after(function () { if (roots) fs.rmSync(roots.base, { recursive: true, force: true }); });

    it('skips only when the run DECLARES it has no indexer, and says nothing was compared', function () {
        const { absentRoot } = roots;
        const { code, out } = runGate({ XCHAIN_INDEXER_PATH: absentRoot, XCHAIN_ALLOW_NO_INDEXER: '1' });
        expect(code, 'declared standalone exit code').to.equal(0);
        expect(out).to.include('XCHAIN_ALLOW_NO_INDEXER=1 declared');
        expect(out, 'the skip states its own cost').to.include('Nothing in src/preflight/INDEXER-MAP.md was compared');
    });

    it('lets XCHAIN_REQUIRE_SIBLINGS=1 override the declaration', function () {
        // A job that sets both is claiming the checkout was supplied, which is the
        // stricter claim; honouring the opt-out there would re-open the silent skip for
        // exactly the sibling job the strict flag exists to protect.
        const { code, out } = runGate({
            XCHAIN_INDEXER_PATH: roots.absentRoot,
            XCHAIN_ALLOW_NO_INDEXER: '1',
            XCHAIN_REQUIRE_SIBLINGS: '1',
        });
        expect(code, 'exit code when both are set').to.equal(1);
        expect(out).to.include('no xchain-indexer checkout resolved');
    });

    it('still resolves and COMPARES a checkout that carries the handler directory', function () {
        // Without this the suite above would pass against a gate that simply always fails.
        // The shaped root resolves, so the run gets past resolution and fails on the
        // handlers themselves, which is a different message.
        const { code, out } = runGate({ XCHAIN_INDEXER_PATH: roots.shapedRoot });
        expect(code, 'exit code for a resolved but empty checkout').to.equal(1);
        expect(out).to.include('mapped handler(s) not found in the checkout');
        expect(out, 'resolution did not fail').to.not.include('no xchain-indexer checkout resolved');
    });
});
