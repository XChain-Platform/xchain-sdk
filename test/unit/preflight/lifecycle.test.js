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
const { mockSdk } = require('./helpers/mock.js');

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

        // §4.7: two approval windows can share (chainId, actionString,
        // source) yet carry DIFFERENT reservation deltas - the second window
        // nets the first's approved-but-unbroadcast amount. If localDeltas were
        // omitted from the key, the delta-carrying pre-flight would coalesce
        // onto the un-netted producer and show a stale "Looks good".
        it('different localDeltas do NOT collide (reservation netting)', async function () {
            const c = new Coalescer();
            let runs = 0;
            const producer = () => { runs++; return Promise.resolve('v'); };
            await Promise.all([
                c.run({ chainId: 'btc', actionString: 'S', source: 's', localDeltas: [] }, producer),
                c.run({ chainId: 'btc', actionString: 'S', source: 's', localDeltas: [{ tick: 'XCHAIN', amount: '600' }] }, producer),
            ]);
            expect(runs).to.equal(2);
        });
    });
});

describe('pre-flight lifecycle', function () {
    describe('coalescing', function () {

        it('identical localDeltas still share one producer', async function () {
            const c = new Coalescer();
            let runs = 0;
            const producer = () => { runs++; return Promise.resolve('v'); };
            await Promise.all([
                c.run({ chainId: 'btc', actionString: 'S', source: 's', localDeltas: [{ tick: 'XCHAIN', amount: '600' }] }, producer),
                c.run({ chainId: 'btc', actionString: 'S', source: 's', localDeltas: [{ tick: 'XCHAIN', amount: '600' }] }, producer),
            ]);
            expect(runs).to.equal(1);
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
});

describe('pre-flight lifecycle', function () {
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

const A = 'SEND|0|JDOG|1|1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2';
const SRC = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2';
const base = { chainId: 'btc', actionString: 'S', source: 's' };

function countingSdk() {
    const calls = [];
    const sdk = mockSdk({ preflight: 'report', explorerSpec: { getPreflight: async (args) => {
        calls.push(args);
        await new Promise(r => setTimeout(r, 10));
        return { supported: true, valid: true, status: 'valid', blockIndex: 7,
            quote: { feeMode: args.feeMode || 'default' } };
    } } });
    return { sdk, calls };
}

describe('pre-flight lifecycle', function () {
    describe('coalescing across caller options', function () {
        it('Coalescer.key differs when only mode, feeMode or encoding differs', function () {
            const c = new Coalescer();
            const k = (v) => c.key('btc', 'S', 's', [], v);
            const same = k({ mode: 'report', feeMode: 'native', encoding: 'OP_RETURN' });
            expect(k({ mode: 'report', feeMode: 'native', encoding: 'OP_RETURN' })).to.equal(same);
            expect(k({ mode: 'local', feeMode: 'native', encoding: 'OP_RETURN' })).to.not.equal(same);
            expect(k({ mode: 'report', feeMode: 'xchain', encoding: 'OP_RETURN' })).to.not.equal(same);
            expect(k({ mode: 'report', feeMode: 'native', encoding: 'P2SH' })).to.not.equal(same);
            expect(k({ mode: 'report', encoding: 'OP_RETURN' })).to.not.equal(same);
        });

        it('Coalescer.run keeps callers that differ in mode, feeMode or encoding apart', async function () {
            for (const diff of [{ mode: 'local' }, { feeMode: 'xchain' }, { encoding: 'P2SH' }]) {
                const c = new Coalescer();
                let runs = 0;
                const producer = () => { runs++; return Promise.resolve({}); };
                const opts = { mode: 'report', feeMode: 'native', encoding: 'OP_RETURN' };
                const [a, b] = await Promise.all([
                    c.run(Object.assign({}, base, opts), producer),
                    c.run(Object.assign({}, base, opts, diff), producer),
                ]);
                expect(runs, JSON.stringify(diff)).to.equal(2);
                expect(a).to.not.equal(b);
            }
        });
    });
});

describe('pre-flight lifecycle', function () {
    describe('coalescing across caller options', function () {
        it('a local caller and a report caller get separate reports; only the report caller reaches Tier 1', async function () {
            for (const order of [['local', 'report'], ['report', 'local']]) {
                const { sdk, calls } = countingSdk();
                const [x, y] = await Promise.all(order.map(m => sdk.preflight(A, { source: SRC, preflight: m })));
                expect(x).to.not.equal(y);
                expect(calls).to.have.length(1);
                const rep = order[0] === 'report' ? x : y;
                const loc = order[0] === 'report' ? y : x;
                expect(rep.quote, order.join()).to.not.equal(null);
                expect(loc.quote).to.equal(null);
            }
        });

        it('feeMode native and xchain callers each get their own verdict', async function () {
            const { sdk, calls } = countingSdk();
            const [n, x] = await Promise.all([
                sdk.preflight(A, { source: SRC, feeMode: 'native' }),
                sdk.preflight(A, { source: SRC, feeMode: 'xchain' }),
            ]);
            expect(n).to.not.equal(x);
            expect(calls).to.have.length(2);
            expect(calls.map(c => c.feeMode).sort()).to.deep.equal(['native', 'xchain']);
        });

        it('encoding OP_RETURN and P2SH callers do not share a report', async function () {
            const { sdk, calls } = countingSdk();
            const [o, p] = await Promise.all([
                sdk.preflight(A, { source: SRC, encoding: 'OP_RETURN' }),
                sdk.preflight(A, { source: SRC, encoding: 'P2SH' }),
            ]);
            expect(o).to.not.equal(p);
            expect(calls).to.have.length(2);
        });

        it('identical options still coalesce onto one producer run', async function () {
            const { sdk, calls } = countingSdk();
            const o = { source: SRC, preflight: 'report', feeMode: 'native', encoding: 'P2SH' };
            const [a, b] = await Promise.all([sdk.preflight(A, o), sdk.preflight(A, Object.assign({}, o))]);
            expect(a).to.equal(b);
            expect(calls).to.have.length(1);
        });
    });
});
