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
 ********************************************************************/

'use strict';

// Regression: a slow sibling load must name itself
//
// test/unit/action-roundtrip-golden.test.js loads the sibling xchain-indexer in
// a `before` hook: src/utility.js plus every handler in src/actions/. That ran
// under mocha's default 5s hook timeout, and mocha attributes a hook failure to
// the FIRST test in the block, so a cold venue checkout produced
//   `"before all" hook for "the two vendored golden copies are byte-identical"`
// which reads as a golden-fixture drift. Pushing 59ffe4f burned a gate run and
// an investigation on a drift that was never there: both committed fixtures
// hashed identically.
//
// This runs that suite in a child mocha with the load forced past a tiny budget
// and asserts the failure names the cross-repo load, not the byte-identity test,
// and that the hook itself never fails.

const { expect }      = require('chai');
const { spawnSync }   = require('child_process');
const fs              = require('fs');
const path            = require('path');

const SDK_ROOT     = path.join(__dirname, '..', '..');
const GOLDEN_TEST  = path.join(SDK_ROOT, 'test', 'unit', 'action-roundtrip-golden.test.js');
const MOCHA_BIN    = path.join(SDK_ROOT, 'node_modules', 'mocha', 'bin', 'mocha.js');
const LOAD_TEST    = 'the sibling xchain-indexer parser loads within its budget';

// Same resolution order the suite under test uses; without a sibling checkout
// the whole round-trip block skips and there is nothing to attribute.
function resolveIndexerRoot() {
    const candidates = [
        process.env.XCHAIN_INDEXER_PATH,
        path.join(SDK_ROOT, '..', 'xchain-indexer'),
    ].filter(Boolean);
    for (const root of candidates) {
        if (fs.existsSync(path.join(root, 'src', 'utility.js')) &&
            fs.existsSync(path.join(root, 'src', 'actions')))
            return root;
    }
    return null;
}

// Run the golden suite in a child mocha and return its json-reporter payload.
function runGoldenSuite(env) {
    const res = spawnSync(process.execPath,
        [MOCHA_BIN, '--reporter', 'json', '--timeout', '5000', '--exit', GOLDEN_TEST],
        { cwd: SDK_ROOT, encoding: 'utf8', env: Object.assign({}, process.env, env) });
    const out   = String(res.stdout || '');
    const start = out.indexOf('{');
    expect(start, `child mocha emitted no json report (stderr: ${res.stderr})`).to.be.at.least(0);
    return JSON.parse(out.slice(start));
}

describe('Regression: the golden suite blames the sibling load, not the fixtures', function () {
    this.timeout(60000); // a child mocha run, plus the forced stall

    const indexerRoot = resolveIndexerRoot();
    let report = null;

    before(function () {
        if (!indexerRoot) {
            this.skip(); // no sibling checkout: the block under test skips too
            return;
        }
        // Force the load past its budget: stall longer than the budget allows.
        report = runGoldenSuite({
            XCHAIN_GOLDEN_FORCE_SLOW_LOAD_MS: '400',
            XCHAIN_GOLDEN_LOAD_BUDGET_MS: '50',
        });
    });

    it('reports the failure against the sibling-load test', function () {
        const titles = report.failures.map((f) => f.fullTitle);
        expect(titles.some((t) => t.includes(LOAD_TEST)),
            `no failure named the sibling load; failures were: ${JSON.stringify(titles)}`).to.equal(true);
    });

    it('names the cross-repo load in the failure message', function () {
        const failure = report.failures.find((f) => f.fullTitle.includes(LOAD_TEST));
        expect(failure.err.message).to.contain('src/actions');
        expect(failure.err.message).to.contain('xchain-indexer');
        expect(failure.err.message).to.contain('budget');
    });

    it('does not attribute the slow load to the byte-identity test', function () {
        const byteIdentity = report.failures.filter((f) => f.fullTitle.includes('byte-identical'));
        for (const f of byteIdentity) {
            expect(f.err.message, 'the byte-identity test carried the load failure').to.not.contain('src/actions');
            expect(f.err.message, 'the byte-identity test carried a hook timeout').to.not.contain('Timeout of');
        }
    });

    it('never fails the hook itself, so mocha cannot mis-name it', function () {
        const hookFailures = report.failures.filter((f) => /"before all" hook/.test(f.fullTitle || f.title || ''));
        expect(hookFailures.map((f) => f.fullTitle),
            'a hook failure is reported against the first test in its block').to.deep.equal([]);
    });

    it('leaves a fast load passing', function () {
        const fast   = runGoldenSuite({ XCHAIN_GOLDEN_FORCE_SLOW_LOAD_MS: '0' });
        const titles = fast.failures.map((f) => f.fullTitle);
        expect(titles.some((t) => t.includes(LOAD_TEST)),
            `the sibling load failed on a warm run: ${JSON.stringify(titles)}`).to.equal(false);
        expect(fast.passes.some((p) => p.fullTitle.includes(LOAD_TEST)),
            'the sibling-load test did not run on a warm load').to.equal(true);
    });
});
