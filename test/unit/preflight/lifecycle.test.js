'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lifecycle suite (spec §4.6): coalescing (same key merges, different
// chainId does not), abort semantics (per-caller signal, shared work
// survives), bypassCache, and staleness primitives.

const { expect } = require('chai');
const { Coalescer, isStale, degraded } = require('../../../src/preflight/lifecycle.js');
const { STALENESS_MS } = require('../../../src/preflight/constants.js');

describe('pre-flight lifecycle', function () {

    describe('coalescing', function () {
        it('identical (chainId, actionString, source) share one producer', async function () {
            const c = new Coalescer();
            let runs = 0;
            const producer = () => { runs++; return new Promise(r => setTimeout(() => r('v'), 10)); };
            const key = { chainId: 'btc', actionString: 'SEND|0|A|1|x', source: 's' };
            const [a, b] = await Promise.all([c.run(key, producer), c.run(key, producer)]);
            expect(runs).to.equal(1);
            expect(a).to.equal('v');
            expect(b).to.equal('v');
        });

        it('different chainId does not collide', async function () {
            const c = new Coalescer();
            let runs = 0;
            const producer = () => { runs++; return Promise.resolve('v'); };
            await Promise.all([
                c.run({ chainId: 'btc', actionString: 'S', source: 's' }, producer),
                c.run({ chainId: 'ltc', actionString: 'S', source: 's' }, producer),
            ]);
            expect(runs).to.equal(2);
        });

        it('bypassCache always runs a fresh producer', async function () {
            const c = new Coalescer();
            let runs = 0;
            const producer = () => { runs++; return Promise.resolve('v'); };
            const key = { chainId: 'btc', actionString: 'S', source: 's' };
            await c.run(key, producer);
            await c.run({ ...key, bypass: true }, producer);
            expect(runs).to.equal(2);
        });

        it('a caller-supplied signal aborts only that view; shared work survives', async function () {
            const c = new Coalescer();
            let resolved = 0;
            const producer = () => new Promise(r => setTimeout(() => { resolved++; r('done'); }, 20));
            const key = { chainId: 'btc', actionString: 'S', source: 's' };
            const controllerA = new AbortController();
            const pA = c.run({ ...key, signal: controllerA.signal }, producer).catch(e => 'aborted:' + e.message);
            const pB = c.run(key, producer);
            controllerA.abort();
            const [a, b] = await Promise.all([pA, pB]);
            expect(a).to.match(/aborted/);
            expect(b).to.equal('done');
            expect(resolved).to.equal(1); // shared producer ran once and completed
        });
    });

    describe('staleness', function () {
        it('a report older than the window is stale', function () {
            const now = 1000000;
            const report = { _stampedAt: now - STALENESS_MS - 1 };
            expect(isStale(report, { now }).stale).to.equal(true);
        });

        it('a fresh report is not stale', function () {
            const now = 1000000;
            const report = { _stampedAt: now - 1000 };
            expect(isStale(report, { now }).stale).to.equal(false);
        });

        it('stateHeight behind the known tip is stale', function () {
            const report = { _stampedAt: Date.now(), stateHeight: 100 };
            expect(isStale(report, { now: Date.now(), knownTip: 101 }).stale).to.equal(true);
        });

        it('degraded detects verdict worsening only', function () {
            expect(degraded('pass', 'warn')).to.equal(true);
            expect(degraded('warn', 'fail')).to.equal(true);
            expect(degraded('fail', 'pass')).to.equal(false);
            expect(degraded('pass', 'pass')).to.equal(false);
        });
    });
});
