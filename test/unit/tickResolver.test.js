// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect } = require('chai');
const TickResolver = require('../../src/tickResolver.js');
const Utility = require('../../src/utility.js');

// Minimal fake SDK exposing only what TickResolver touches: options, util,
// and an explorer stub whose getToken returns a token doc (or throws).
function makeSdk(opts = {}, getToken = null) {
    return {
        options: opts.options || {},
        util: new Utility(),
        explorer: getToken ? { getToken } : (opts.noExplorer ? null : { getToken: async () => { throw new Error('not stubbed'); } })
    };
}

// Build a getToken stub that maps name -> tick_id, throwing for unknown names
// (mirrors the explorer 404ing on a non-existent token).
function tokenStub(map) {
    return async (tick) => {
        let key = String(tick).toLowerCase();
        if (!(key in map)) throw new Error('404 token not found');
        return { info: { tick: tick, tick_id: map[key] } };
    };
}

describe('TickResolver', function () {

    describe('resolve()', function () {

        it('rewrites a known ticker name to its ^<id> form', async function () {
            const r = new TickResolver(makeSdk({}, tokenStub({ jdog: 1234 })));
            expect(await r.resolve('JDOG')).to.equal('^1234');
        });

        it('passes an already-^id reference through untouched (no lookup)', async function () {
            let called = false;
            const r = new TickResolver(makeSdk({}, async () => { called = true; return {}; }));
            expect(await r.resolve('^1234')).to.equal('^1234');
            expect(called).to.equal(false);
        });

        it('falls back to the name when the token is not indexed (lookup throws)', async function () {
            const r = new TickResolver(makeSdk({}, tokenStub({ jdog: 1234 })));
            expect(await r.resolve('NEWCOIN')).to.equal('NEWCOIN');
        });

        it('falls back to the name when no explorer is wired', async function () {
            const r = new TickResolver(makeSdk({ noExplorer: true }));
            expect(await r.resolve('JDOG')).to.equal('JDOG');
        });

        it('returns the name unchanged when compaction is disabled', async function () {
            const r = new TickResolver(makeSdk({ options: { compactTickers: false } }, tokenStub({ jdog: 1234 })));
            expect(await r.resolve('JDOG')).to.equal('JDOG');
        });

        it('caches the id so a second resolve does not hit the explorer', async function () {
            let calls = 0;
            const r = new TickResolver(makeSdk({}, async (tick) => { calls++; return { info: { tick, tick_id: 7 } }; }));
            expect(await r.resolve('FOO')).to.equal('^7');
            expect(await r.resolve('foo')).to.equal('^7'); // case-insensitive cache hit
            expect(calls).to.equal(1);
        });

        it('passes empty / null / undefined through untouched', async function () {
            const r = new TickResolver(makeSdk({}, tokenStub({})));
            expect(await r.resolve('')).to.equal('');
            expect(await r.resolve(null)).to.equal(null);
            expect(await r.resolve(undefined)).to.equal(undefined);
        });
    });

    describe('resolveActionParams()', function () {

        it('compacts the TICK field of a SEND', async function () {
            const r = new TickResolver(makeSdk({}, tokenStub({ jdog: 1234 })));
            const out = await r.resolveActionParams('SEND', { TICK: 'JDOG', AMOUNT: '1', DESTINATION: 'addr' });
            expect(out.TICK).to.equal('^1234');
            expect(out.AMOUNT).to.equal('1');
        });

        it('accepts camelCase keys and preserves their casing while compacting the value', async function () {
            const r = new TickResolver(makeSdk({}, tokenStub({ jdog: 1234 })));
            const out = await r.resolveActionParams('SEND', { tick: 'JDOG', amount: '1' });
            expect(out.tick).to.equal('^1234');   // original key casing preserved
            expect(out.TICK).to.equal(undefined); // normalization stays the builder's job
            expect(out.amount).to.equal('1');
        });

        it('leaves non-ticker params byte-for-byte untouched', async function () {
            const r = new TickResolver(makeSdk({}, tokenStub({ jdog: 1234 })));
            const out = await r.resolveActionParams('SEND', { k: 'v', other: 5 });
            expect(out).to.deep.equal({ k: 'v', other: 5 });
        });

        it('does NOT compact the defining TICK of an ISSUE', async function () {
            const r = new TickResolver(makeSdk({}, tokenStub({ jdog: 1234 })));
            const out = await r.resolveActionParams('ISSUE', { TICK: 'JDOG' });
            expect(out.TICK).to.equal('JDOG');
        });

        it('compacts CALLBACK_TICK on an ISSUE (references an existing token)', async function () {
            const r = new TickResolver(makeSdk({}, tokenStub({ jdog: 1234, usd: 55 })));
            const out = await r.resolveActionParams('ISSUE', { TICK: 'JDOG', CALLBACK_TICK: 'USD' });
            expect(out.TICK).to.equal('JDOG');           // defining ticker untouched
            expect(out.CALLBACK_TICK).to.equal('^55');   // referenced token compacted
        });

        it('compacts both TICK and DIVIDEND_TICK on a DIVIDEND', async function () {
            const r = new TickResolver(makeSdk({}, tokenStub({ jdog: 1234, usd: 55 })));
            const out = await r.resolveActionParams('DIVIDEND', { TICK: 'JDOG', DIVIDEND_TICK: 'USD', AMOUNT: '1' });
            expect(out.TICK).to.equal('^1234');
            expect(out.DIVIDEND_TICK).to.equal('^55');
        });

        it('passes params straight through when disabled', async function () {
            const r = new TickResolver(makeSdk({ options: { compactTickers: false } }, tokenStub({ jdog: 1234 })));
            const input = { TICK: 'JDOG', AMOUNT: '1' };
            const out = await r.resolveActionParams('SEND', input);
            expect(out).to.equal(input); // same reference, untouched
        });
    });
});
