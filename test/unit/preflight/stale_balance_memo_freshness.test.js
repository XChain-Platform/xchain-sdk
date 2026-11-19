'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const { mockSdk } = require('./helpers/mock.js');
const { CheckContext } = require('../../../src/preflight/context.js');

const H = 'n4LCDuwBxvTXAGQuswuTDAicNxtgUwxjDa';
const STALE = { stale: true, tipBlock: 416, tipAgeSeconds: 10657639 };
const FRESH = { stale: false, tipBlock: 114903 };

function contextFor(sdk) {
    return new CheckContext({
        sdk, parsed: { params: {} }, source: H, mode: 'report', timeoutMs: 5000,
    });
}

function tokenFreshnessSdk({ rows, listingFreshness, tokenFreshness }) {
    let last = null;
    let balanceReads = 0;
    const sdk = mockSdk({
        preflight: 'report',
        explorerSpec: {
            getToken: (tick) => {
                last = tokenFreshness(tick);
                return { info: { tick: String(tick) }, decimals: 8 };
            },
            getBalances: () => {
                balanceReads++;
                last = listingFreshness;
                return rows;
            },
        },
    });
    sdk.explorer.freshness = () => last;
    return { sdk, balanceReads: () => balanceReads };
}

describe('pre-flight memoized balance freshness', function () {
    it('keeps a stale empty listing unverified after a fresh token read', async function () {
        const built = tokenFreshnessSdk({
            rows: [], listingFreshness: STALE, tokenFreshness: () => FRESH,
        });
        const ctx = contextFor(built.sdk);

        expect(await ctx.balance(H, 'A')).to.equal(null);
        expect(await ctx.balance(H, 'B')).to.equal(null);
        expect(built.balanceReads()).to.equal(1);
        expect(ctx.unverified.some((u) => u.check === 'BALANCE_LOOKUP' && /B row/.test(u.reason))).to.equal(true);
    });

    it('keeps a cached positive row marked stale for the second tick', async function () {
        const built = tokenFreshnessSdk({
            rows: [{ tick: 'A', quantity: '5' }, { tick: 'B', quantity: '0.5' }],
            listingFreshness: STALE,
            tokenFreshness: () => FRESH,
        });
        const ctx = contextFor(built.sdk);

        expect(await ctx.balance(H, 'A')).to.equal('5');
        expect(await ctx.balance(H, 'B')).to.equal('0.5');
        const finding = ctx.addFinding('BALANCE_INSUFFICIENT', 'error', 'shortfall', { tick: 'B' });
        expect(finding.data.staleMirror).to.equal(true);
        expect(ctx.unverified.some((u) => u.check === 'BALANCE_LOOKUP' && /B balance/.test(u.reason))).to.equal(true);
    });

    it('does not make a fresh cached listing stale after a stale token read', async function () {
        const built = tokenFreshnessSdk({
            rows: [], listingFreshness: FRESH,
            tokenFreshness: (tick) => tick === 'B' ? STALE : FRESH,
        });
        const ctx = contextFor(built.sdk);

        expect(await ctx.balance(H, 'A')).to.equal('0');
        expect(await ctx.balance(H, 'B')).to.equal('0');
        expect(ctx.unverified.filter((u) => u.check === 'BALANCE_LOOKUP')).to.deep.equal([]);
    });

    it('keeps a memoized stale native balance tied to its address read', async function () {
        let last = null;
        let addressReads = 0;
        const sdk = mockSdk({
            preflight: 'report',
            explorerSpec: {
                getToken: (tick) => {
                    last = FRESH;
                    return { info: { tick: String(tick) }, decimals: 8 };
                },
            },
        });
        sdk.explorer.coin = 'BTC';
        sdk.explorer.freshness = () => last;
        sdk.getAddress = async () => {
            addressReads++;
            last = STALE;
            return { balances: { confirmed: '0' } };
        };
        const ctx = contextFor(sdk);

        expect(await ctx.balance(H, 'BTC')).to.equal(null);
        await ctx.token('X');
        expect(await ctx.balance(H, 'BTC')).to.equal(null);
        expect(addressReads).to.equal(1);
    });
});
