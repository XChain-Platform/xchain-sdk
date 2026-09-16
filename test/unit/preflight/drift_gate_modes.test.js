'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Drift-gate RUN MODES and the ci wiring that depends on them.
//
// A drift exiting 1 as the first link of `npm run ci` kills the run before
// mocha loads: no test tally and no named failing test is exactly the
// signature the shared pre-push gate reads as THE SUITE NEVER RAN, unable to
// distinguish a bad commit from a bad venue. The gate instead fails SOFT:
// report the drift, let the suites run, fail the run afterwards.
//
// That makes the modes load-bearing, so they are tested as behaviour (spawned
// processes, real exit codes) rather than as functions, and the ci chain's
// open-soft/close-verdict pairing is asserted too: opening strict makes a drift
// fatal at load again, and dropping the close ships a drift green. Either half
// alone silently undoes the fix.

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SDK_ROOT = path.join(__dirname, '..', '..', '..');
const GATE = path.join(SDK_ROOT, 'bin', 'check-preflight-drift.js');

// A deliberately broken indexer root: it carries src/actions/ (which is what
// resolveIndexerRoot looks for, so the real sibling is never consulted) and
// nothing else, so every check fails for a reason that cannot depend on what
// a second coder has in the sibling checkout right now.
function createFixtureRoot() {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-gate-modes-'));
    fs.mkdirSync(path.join(fixtureRoot, 'src', 'actions'), { recursive: true });
    return fixtureRoot;
}

function removeFixtureRoot(fixtureRoot) {
    if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

function runGate(args, fixtureRoot) {
    const r = spawnSync(process.execPath, [GATE, ...args], {
        cwd: SDK_ROOT,
        encoding: 'utf8',
        env: { ...process.env, XCHAIN_INDEXER_PATH: fixtureRoot },
    });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// The CLEAN verdict cannot be produced from a fixture (the pins are real handler
// bytes) and reading it off the live sibling would make this suite pass or fail on
// whatever a second coder has in that checkout today, which is precisely the
// non-hermetic coupling the sibling suite refuses. So the clean side is driven
// through main()'s injected evaluator: what is under test here is the exit code and
// the wording each verdict selects, not the checks, which the fixture runs cover.
function runMain(args, verdict) {
    const script = `const g = require(${JSON.stringify(GATE)}); g.main(${JSON.stringify(args)}, () => ${verdict});`;
    const r = spawnSync(process.execPath, ['-e', script], { cwd: SDK_ROOT, encoding: 'utf8' });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

describe('drift gate run modes (§8.5)', function () {
    this.timeout(20000);

    let fixtureRoot;

    before(function () {
        fixtureRoot = createFixtureRoot();
    });

    after(function () {
        removeFixtureRoot(fixtureRoot);
    });

    it('strict (no flag) still exits 1 and prints the finding', function () {
        // Unchanged behaviour, and it must stay unchanged: CI's own drift job and
        // the indexer-side gate both run the bare script and rely on the exit code.
        const { code, out } = runGate([], fixtureRoot);
        expect(code, 'strict mode exit code').to.equal(1);
        expect(out).to.include('mapped handler(s) not found in the checkout');
    });

    it('--soft prints the same finding and exits 0, so the suites still run', function () {
        const strict = runGate([], fixtureRoot);
        const soft = runGate(['--soft'], fixtureRoot);
        expect(soft.code, '--soft exit code').to.equal(0);
        // Same report, not a quieter one: the soft run is what a reviewer reads.
        expect(soft.out).to.include('mapped handler(s) not found in the checkout');
        for (const line of strict.out.split('\n').filter((l) => l.trim()))
            expect(soft.out, 'soft output keeps every strict line').to.include(line);
    });
});

describe('drift gate run modes (§8.5)', function () {
    this.timeout(20000);

    let fixtureRoot;

    before(function () {
        fixtureRoot = createFixtureRoot();
    });

    after(function () {
        removeFixtureRoot(fixtureRoot);
    });

    it('--soft says the finding is not waived and names where it lands', function () {
        // The failure mode this guards is a future reader seeing exit 0 and
        // concluding the drift was tolerated.
        const { out } = runGate(['--soft'], fixtureRoot);
        expect(out).to.include('NOT fatal here');
        expect(out).to.include('ci:drift:verdict');
        expect(out).to.include('Nothing above is waived');
    });

    it('--verdict exits 1 on the same finding without re-printing the report', function () {
        const { code, out } = runGate(['--verdict'], fixtureRoot);
        expect(code, '--verdict exit code').to.equal(1);
        expect(out).to.include('drift-gate: FAILED');
        // Muted: one `npm run ci` runs the gate twice, and printing the full
        // report at both ends would read as two separate findings.
        expect(out).to.not.include('mapped handler(s) not found in the checkout');
        expect(out.split('\n').length, '--verdict stays short').to.be.lessThan(8);
    });
});

describe('drift gate run modes (§8.5)', function () {
    this.timeout(20000);

    it('--verdict is silent-clean and exits 0 when there is nothing to report', function () {
        const { code, out } = runMain(['--verdict'], 0);
        expect(code, '--verdict clean exit code').to.equal(0);
        expect(out).to.include('drift-gate: clean.');
        expect(out, 'a clean verdict says nothing about failing').to.not.include('FAILED');
    });

    it('a clean gate is not softened into something else by --soft', function () {
        const { code, out } = runMain(['--soft'], 0);
        expect(code, '--soft clean exit code').to.equal(0);
        expect(out, 'no not-waived banner when there is no finding').to.not.include('NOT fatal here');
    });
});

describe('drift gate run modes (§8.5)', function () {
    this.timeout(20000);

    /* The no-checkout branch, which is the one a dropped CI checkout step lands on.
     *
     * It FAILS unless the run declares it has no sibling. Skipping by default was the
     * defect: the gate exited 0 having compared no handler at all, which is how a
     * cross-repo guard regresses to green-by-skip with no signal. The full resolution
     * behaviour is driven in drift_gate_sibling_resolution.test.js; what is kept here is
     * the pair this suite is about, the declared skip and the strict override.
     */
    describe('no resolvable indexer checkout', function () {
        // Under this name nothing resolves, and an explicit XCHAIN_INDEXER_PATH is
        // authoritative, so the sibling beside a real checkout cannot answer for it.
        const absent = path.join(os.tmpdir(), 'drift-gate-no-such-checkout');

        function runAbsent(env) {
            const r = spawnSync(process.execPath, [GATE], {
                cwd: SDK_ROOT,
                encoding: 'utf8',
                env: { ...process.env, XCHAIN_INDEXER_PATH: absent, ...env },
            });
            return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
        }

        it('skips green for a DECLARED standalone clone', function () {
            const { code, out } = runAbsent({ XCHAIN_REQUIRE_SIBLINGS: '', XCHAIN_ALLOW_NO_INDEXER: '1' });
            expect(code, 'standalone clone exit code').to.equal(0);
            expect(out).to.include('skipping the sibling checks');
        });

        it('fails when the same run does NOT declare it', function () {
            // The skip is a choice the run makes, never something inferred from a missing
            // directory. Same fixture, one variable dropped, opposite verdict.
            const { code } = runAbsent({ XCHAIN_REQUIRE_SIBLINGS: '', XCHAIN_ALLOW_NO_INDEXER: '' });
            expect(code, 'undeclared missing checkout exit code').to.equal(1);
        });

        it('FAILS under XCHAIN_REQUIRE_SIBLINGS=1, naming the path it tried', function () {
            const { code, out } = runAbsent({ XCHAIN_REQUIRE_SIBLINGS: '1' });
            expect(code, 'required-sibling exit code').to.equal(1);
            expect(out, 'names the checkout that is missing').to.include(absent);
            expect(out, 'no longer reports a skip').to.not.include('skipping the sibling checks');
        });
    });
});

describe('drift gate run modes (§8.5)', function () {
    this.timeout(20000);

    describe('ci chain wiring', function () {
        const pkg = require(path.join(SDK_ROOT, 'package.json'));

        it('`ci` OPENS with the soft gate, never the fatal one', function () {
            // `npm run ci:drift && ...` is the exact shape that produced three
            // NEVER RAN pushes; it must not come back.
            expect(pkg.scripts.ci).to.match(/^npm run ci:drift:soft &&/);
            expect(pkg.scripts.ci, 'no fatal drift link at the head')
                .to.not.match(/^npm run ci:drift &&/);
        });

        it('`ci` CLOSES with the verdict gate, so a drift cannot ship green', function () {
            expect(pkg.scripts.ci).to.match(/&& npm run ci:drift:verdict$/);
        });

        it('both halves point at the one gate script, with the modes it implements', function () {
            expect(pkg.scripts['ci:drift']).to.equal('node bin/check-preflight-drift.js');
            expect(pkg.scripts['ci:drift:soft']).to.equal('node bin/check-preflight-drift.js --soft');
            expect(pkg.scripts['ci:drift:verdict']).to.equal('node bin/check-preflight-drift.js --verdict');
        });

        it('the suites still sit BETWEEN the two halves, which is the whole point', function () {
            const ci = pkg.scripts.ci;
            expect(ci.indexOf('mocha'), 'unit suite runs after the soft gate')
                .to.be.greaterThan(ci.indexOf('ci:drift:soft'));
            expect(ci.indexOf('ci:drift:verdict'), 'verdict runs after the last suite')
                .to.be.greaterThan(ci.indexOf('ci:regression'));
        });
    });
});
