'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The pre-flight timeout is ONE budget for the whole run (constants.js:
// DEFAULT_TIMEOUT_MS is the overall per-preflight budget, RECHECK_TIMEOUT_MS
// the Approve-time re-check budget). Tier 2 reads run one after another
// (the token lookup, then the balance listing), so a budget handed to each
// read separately let a stalled explorer hold a pre-flight for about twice
// its stated budget. These cases stall every endpoint and check that the
// report comes back within the budget, that a read which would start after
// the budget is spent is marked unverified without being sent, and that a
// Tier 2 timeout is not reported as a Tier 1 one.

const { expect } = require('chai');
const sinon = require('sinon');
const { mockSdk } = require('./helpers/mock.js');

const DEST = 'mxNAZQtCRBG3dYu2ufVxSsc7V3c8jh9HDM';
const SOURCE = 'n4LCDuwBxvTXAGQuswuTDAicNxtgUwxjDa';
const ACTION = 'SEND|0|XCHAIN|1|' + DEST + '|budget';

// An SDK whose every explorer read hangs forever, with a call counter per
// endpoint so a test can tell a read that was never sent from one that hung.
function stalledSdk() {
    const calls = { getPreflight: 0, getToken: 0, getBalances: 0, getAddress: 0 };
    const hang = (name) => () => { calls[name] += 1; return new Promise(() => {}); };
    const sdk = mockSdk({ explorerSpec: {
        getPreflight: hang('getPreflight'),
        getToken: hang('getToken'),
        getBalances: hang('getBalances'),
    } });
    sdk.getAddress = hang('getAddress');
    return { sdk, calls };
}

function unverifiedChecks(report) {
    return report.unverified.map(u => u.check);
}

function registerRealClockCases() {
    it('a stalled explorer returns within the budget, not once per sequential read', async function () {
        const budget = 300;
        const { sdk, calls } = stalledSdk();
        const t0 = Date.now();
        const r = await sdk.preflight(ACTION,
            { source: SOURCE, bypassCache: true, preflight: 'report', timeoutMs: budget });
        const wall = Date.now() - t0;

        expect(r.elapsedMs, 'report.elapsedMs').to.be.below(budget * 1.5);
        expect(wall, 'wall clock').to.be.below(budget * 1.5);
        expect(calls.getToken).to.equal(1);
        const checks = unverifiedChecks(r);
        expect(checks).to.include('TOKEN_LOOKUP');
        expect(checks).to.include('BALANCE_LOOKUP');
    });

    it('a read due after the budget is spent is unverified at once and never sent', async function () {
        const { sdk, calls } = stalledSdk();
        const r = await sdk.preflight(ACTION,
            { source: SOURCE, bypassCache: true, preflight: 'report', timeoutMs: 150 });
        // The token lookup used the whole budget; the balance listing that
        // follows it must not open a fresh timer of its own.
        expect(calls.getBalances).to.equal(0);
        expect(unverifiedChecks(r)).to.include('BALANCE_LOOKUP');
    });

    it('a Tier 2 read timeout is not reported as a Tier 1 timeout', async function () {
        const { sdk } = stalledSdk();
        const r = await sdk.preflight(ACTION,
            { source: SOURCE, bypassCache: true, preflight: 'report', timeoutMs: 150 });
        const tier2 = r.unverified.filter(u => u.check === 'TOKEN_LOOKUP' || u.check === 'BALANCE_LOOKUP');
        expect(tier2.length).to.be.at.least(2);
        for (const u of tier2) expect(u.reason).to.not.match(/tier1/i);
        // Tier 1's own timeout still names itself.
        const dry = r.findings.find(f => f.code === 'DRYRUN_UNAVAILABLE');
        expect(dry, 'stalled dry-run is disclosed').to.not.equal(undefined);
        expect(dry.message).to.match(/timeout/i);
    });

}

function registerFakeClockCase() {
    describe('with the default budget (fake clock)', function () {
        let clock;
        beforeEach(function () {
            clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        });
        afterEach(function () { clock.restore(); });

        it('the default 4000ms budget bounds the whole run, not each read', async function () {
            const { DEFAULT_TIMEOUT_MS } = require('../../../src/preflight/constants.js');
            const { sdk, calls } = stalledSdk();
            const t0 = Date.now();
            const pending = sdk.preflight(ACTION,
                { source: SOURCE, bypassCache: true, preflight: 'report' });
            await clock.tickAsync(DEFAULT_TIMEOUT_MS * 3);
            const r = await pending;

            expect(r.elapsedMs).to.be.at.most(DEFAULT_TIMEOUT_MS);
            expect(Date.now() - t0).to.be.at.least(DEFAULT_TIMEOUT_MS * 3);
            expect(calls.getBalances).to.equal(0);
            const checks = unverifiedChecks(r);
            expect(checks).to.include('TOKEN_LOOKUP');
            expect(checks).to.include('BALANCE_LOOKUP');
        });
    });
}

describe('pre-flight timeout is one overall budget', function () {
    registerRealClockCases();
    registerFakeClockCase();
});
