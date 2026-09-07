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
 **********************************************************************
 * The explorer serves a coin whose indexed tip is behind, marked rather
 * than refused: XChain-Freshness / XChain-Tip-Block / XChain-Tip-Age-S on
 * every data response, a `freshness` body object while stale, and the
 * `stale` map on /status. These pin how the SDK reads those markers and how
 * assertFresh turns a stale one into a typed error.
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const nock = require('nock');
const ExplorerClient   = require('../../src/explorer.js');
const XChainSDK        = require('../../src/XChainSDK.js');
const LifecycleManager = require('../../src/lifecycleManager.js');
const { SDKExplorerError } = require('../../src/errors.js');

const BASE = 'http://explorer.test:8080';

function client() {
    return new ExplorerClient({ network: 'bitcoin-mainnet', explorerUrl: 'explorer.test', explorerPort: 8080, retry: false });
}

function sdk() {
    return new XChainSDK({ network: 'bitcoin-mainnet', explorerUrl: BASE, encoderUrl: 'http://localhost:3000', retry: false });
}

describe('ExplorerClient freshness markers', function () {
    afterEach(function () { nock.cleanAll(); });

    it('is null before any marked response has been seen', function () {
        expect(client().freshness()).to.equal(null);
    });

    it('reads the live marker off the headers of an ordinary data response', async function () {
        nock(BASE).get('/BTC/api/balances/addr1').reply(200, { total: 0, data: [] },
            { 'XChain-Freshness': 'live', 'XChain-Tip-Block': '965947', 'XChain-Tip-Age-S': '169' });
        let c = client();
        await c.getBalances('addr1');
        let f = c.freshness();
        expect(f.stale).to.equal(false);
        expect(f.tipBlock).to.equal(965947);
        expect(f.tipAgeSeconds).to.equal(169);
        expect(f.replicaHalted).to.equal(null);
        expect(f.observedAt).to.be.a('number');
    });

    it('prefers the body object on a stale response, which also carries the halt signal', async function () {
        nock(BASE).get('/BTC/api/balances/addr1').reply(200,
            { total: 0, data: [], freshness: { stale: true, tip_block: 151038, tip_age_seconds: 215254, replica_halted: true } },
            { 'XChain-Freshness': 'stale', 'XChain-Tip-Block': '151038', 'XChain-Tip-Age-S': '215254' });
        let c = client();
        await c.getBalances('addr1');
        expect(c.freshness()).to.include({ stale: true, tipBlock: 151038, tipAgeSeconds: 215254, replicaHalted: true });
    });

    it('leaves the record untouched on a response with no marker (an older explorer)', async function () {
        nock(BASE).get('/BTC/api/balances/addr1').reply(200, { total: 0, data: [] },
            { 'XChain-Freshness': 'stale', 'XChain-Tip-Block': '5' });
        nock(BASE).get('/BTC/api/balances/addr2').reply(200, { total: 0, data: [] });
        let c = client();
        await c.getBalances('addr1');
        await c.getBalances('addr2');
        expect(c.freshness().stale).to.equal(true);
    });

    it('hands back a copy, so a caller cannot edit the record', async function () {
        nock(BASE).get('/BTC/api/balances/addr1').reply(200, { total: 0, data: [] }, { 'XChain-Freshness': 'live' });
        let c = client();
        await c.getBalances('addr1');
        c.freshness().stale = true;
        expect(c.freshness().stale).to.equal(false);
    });
});

describe('XChainSDK.assertFresh', function () {
    afterEach(function () { nock.cleanAll(); });

    const status = (stale) => ({
        stale:           { BTC: stale, TBTC: true },
        last_block:      { BTC: 965947, TBTC: 151038 },
        tip_age_seconds: { BTC: 169, TBTC: 215254 },
        replica_halted:  { BTC: false, TBTC: true }
    });

    it('probes /status when nothing marked has been seen, and passes on a live coin', async function () {
        nock(BASE).get('/BTC/api/status').reply(200, status(false));
        let f = await sdk().assertFresh();
        expect(f).to.include({ stale: false, tipBlock: 965947, tipAgeSeconds: 169, replicaHalted: false });
    });

    it('throws SDKExplorerError COIN_DATA_STALE on a stale coin, carrying the freshness record', async function () {
        nock(BASE).get('/BTC/api/status').reply(200, status(true));
        try {
            await sdk().assertFresh();
            expect.fail('should have thrown');
        } catch (e) {
            expect(e.name).to.equal('SDKExplorerError');
            expect(e.code).to.equal('COIN_DATA_STALE');
            expect(e.details.freshness.tipBlock).to.equal(965947);
            expect(e.message).to.include('behind the chain');
        }
    });

    it('reads only its own coin off /status, never a stale sibling', async function () {
        nock(BASE).get('/BTC/api/status').reply(200, status(false));
        let f = await sdk().assertFresh();
        expect(f.stale).to.equal(false);
    });

    it('passes a coin the explorer does not measure, flagged as unmeasured', async function () {
        nock(BASE).get('/BTC/api/status').reply(200, { stale: { TBTC: true } });
        let f = await sdk().assertFresh();
        expect(f.stale).to.equal(false);
        expect(f.measured).to.equal(false);
    });

    it('uses a recent per-response marker without a /status round trip', async function () {
        nock(BASE).get('/BTC/api/balances/addr1').reply(200, { total: 0, data: [] }, { 'XChain-Freshness': 'live', 'XChain-Tip-Block': '7' });
        let s = sdk();
        await s.getBalances('addr1');
        let f = await s.assertFresh();            // no /status nock: a probe here would throw
        expect(f.tipBlock).to.equal(7);
        expect(s.freshness().tipBlock).to.equal(7);
    });

    it('re-probes once the last marker is older than maxAgeMs', async function () {
        nock(BASE).get('/BTC/api/balances/addr1').reply(200, { total: 0, data: [] }, { 'XChain-Freshness': 'live', 'XChain-Tip-Block': '7' });
        nock(BASE).get('/BTC/api/status').reply(200, status(true));
        let s = sdk();
        await s.getBalances('addr1');
        try {
            await s.assertFresh({ maxAgeMs: 0 });
            expect.fail('should have thrown');
        } catch (e) {
            expect(e.code).to.equal('COIN_DATA_STALE');
        }
    });
});

describe('LifecycleManager strictFreshness', function () {
    const FAKE_WIF = 'cVbZ8ovhye9AoAHFsqobTVBDeLL3qMPpq4x8dXWn2rYcahUUV5jt';

    // The smallest SDK double that reaches the freshness gate: the gate runs
    // after the encoder requirement and before any resolver or encoder call.
    function makeSdk(stale) {
        const trace = [];
        return {
            trace,
            _requireEncoder: () => ({ createTx: async () => { trace.push('createTx'); throw new Error('stop here'); } }),
            assertFresh: async () => {
                trace.push('assertFresh');
                if (stale) throw new SDKExplorerError('COIN_DATA_STALE', 'behind', {});
            },
            tickResolver:    { resolveActionParams: async (a, p) => { trace.push('resolve'); return p; } },
            addressResolver: { resolveActionParams: async (a, p) => p },
            actions:         { createAction: () => ({ actionString: 'xc:test' }) }
        };
    }

    const submit = (sdk, opts) => new LifecycleManager(sdk).submitAction(
        { action: 'SEND', params: {} }, { pubkey: '03abc' },
        Object.assign({ wif: FAKE_WIF, waitForIndexer: false }, opts));

    it('refuses before anything is resolved or encoded when the coin is stale', async function () {
        const sdk = makeSdk(true);
        try {
            await submit(sdk, { strictFreshness: true });
            expect.fail('should have thrown');
        } catch (e) {
            expect(e.code).to.equal('COIN_DATA_STALE');
        }
        expect(sdk.trace).to.deep.equal(['assertFresh']);
    });

    it('proceeds past the gate when the coin is live', async function () {
        const sdk = makeSdk(false);
        try { await submit(sdk, { strictFreshness: true }); } catch (e) { /* the encoder double stops the run */ }
        expect(sdk.trace.slice(0, 2)).to.deep.equal(['assertFresh', 'resolve']);
    });

    it('does not consult freshness at all by default, so a wallet keeps working through a stall', async function () {
        const sdk = makeSdk(true);
        try { await submit(sdk, {}); } catch (e) { /* the encoder double stops the run */ }
        expect(sdk.trace).to.not.include('assertFresh');
        expect(sdk.trace[0]).to.equal('resolve');
    });
});
