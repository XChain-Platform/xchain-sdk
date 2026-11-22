'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A balance read keeps the freshness marker of the response that supplied it even
// when another explorer response replaces the client-wide marker before the read
// resumes. The client here is the real ExplorerClient, so the per-response record
// comes from its transport and not from a stub.

const { expect } = require('chai');
const nock = require('nock');
const ExplorerClient = require('../../../src/clients/explorer.js');
const { mockSdk } = require('./helpers/mock.js');
const { CheckContext } = require('../../../src/preflight/context.js');

const BASE = 'http://explorer.test:8080';
const H = 'n4LCDuwBxvTXAGQuswuTDAicNxtgUwxjDa';
const STALE_HEADERS = { 'XChain-Freshness': 'stale', 'XChain-Tip-Block': '416', 'XChain-Tip-Age-S': '10657639' };
const LIVE = { headers: { 'xchain-freshness': 'live', 'xchain-tip-block': '114903' }, data: { total: 0, data: [] } };

function realClient() {
    return new ExplorerClient({ network: 'bitcoin-mainnet', explorerUrl: 'explorer.test', explorerPort: 8080, retry: false });
}

function contextFor(sdk) {
    return new CheckContext({ sdk, parsed: { params: {} }, source: H, mode: 'report', timeoutMs: 5000 });
}

// A fresh response lands on the client between the stale read being recorded and the
// preflight resuming from its await, the order two concurrent requests can produce.
function overwriteWithLive(real, body) {
    real.recordFreshness(LIVE);
    return body;
}

describe('pre-flight balance freshness under a concurrent response', function () {
    afterEach(function () { nock.cleanAll(); });

    it('keeps a stale empty listing unverified when a fresh response lands before the read resumes', async function () {
        nock(BASE).get('/BTC/api/balances/' + H).reply(200, { total: 0, data: [] }, STALE_HEADERS);
        const real = realClient();
        const sdk = mockSdk({ preflight: 'report', explorerSpec: {} });
        sdk.explorer = Object.create(real);
        sdk.explorer.getToken = async (tick) => ({ info: { tick: String(tick) }, decimals: 8 });
        sdk.explorer.getBalances = async (address, opts) => overwriteWithLive(real, await real.getBalances(address, opts));
        const ctx = contextFor(sdk);

        expect(await ctx.balance(H, 'A')).to.equal(null);
        expect(real.freshness().stale).to.equal(false);
        expect(ctx.unverified.some((u) => u.check === 'BALANCE_LOOKUP' && /A row/.test(u.reason))).to.equal(true);
    });

    it('keeps a stale native zero unverified when a fresh response lands before the read resumes', async function () {
        nock(BASE).get('/BTC/api/address/' + H).reply(200, { balances: { confirmed: '0' } }, STALE_HEADERS);
        const real = realClient();
        const sdk = mockSdk({ preflight: 'report', explorerSpec: {} });
        sdk.explorer = Object.create(real);
        sdk.getAddress = async (address) => overwriteWithLive(real, await real.getAddress(address));
        const ctx = contextFor(sdk);

        expect(await ctx.balance(H, 'BTC')).to.equal(null);
        expect(real.freshness().stale).to.equal(false);
        expect(ctx.unverified.some((u) => u.check === 'NATIVE_BALANCE_LOOKUP' && /stale mirror/.test(u.reason))).to.equal(true);
    });

    it('does not mark a fresh listing stale when a stale response lands before the read resumes', async function () {
        nock(BASE).get('/BTC/api/balances/' + H).reply(200, { total: 0, data: [] },
            { 'XChain-Freshness': 'live', 'XChain-Tip-Block': '114903' });
        const real = realClient();
        const sdk = mockSdk({ preflight: 'report', explorerSpec: {} });
        sdk.explorer = Object.create(real);
        sdk.explorer.getToken = async (tick) => ({ info: { tick: String(tick) }, decimals: 8 });
        sdk.explorer.getBalances = async (address, opts) => {
            const body = await real.getBalances(address, opts);
            real.recordFreshness({ headers: { 'xchain-freshness': 'stale' }, data: {} });
            return body;
        };
        const ctx = contextFor(sdk);

        expect(await ctx.balance(H, 'A')).to.equal('0');
        expect(ctx.unverified.filter((u) => u.check === 'BALANCE_LOOKUP')).to.deep.equal([]);
    });
});
