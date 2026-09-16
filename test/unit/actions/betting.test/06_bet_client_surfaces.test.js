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
const { XChainSDK } = require('../../../../index.js');
const BettingHelpers = require('../../../../src/actions/betting.js');

function sdk() {
    // compactTickers:false keeps createAction off the network.
    return new XChainSDK({ network: 'bitcoin-mainnet', compactTickers: false });
}

describe('BET client surfaces', function () {

    it('exposes the explorer read endpoints on the route paths the explorer registers', async function () {
        const s = sdk();
        const calls = [];
        // Stub the transport: this asserts the PATH each helper builds, which is
        // the half that silently 404s if it drifts from the explorer route map.
        s.explorer = { get: async (path) => { calls.push(path); return {}; } };
        Object.setPrototypeOf(s.explorer, require('../../../../src/clients/explorer.js').prototype);

        await s.explorer.getBetFeeds('open', 'status');
        await s.explorer.getBetFeed(1234);
        await s.explorer.getBets('1234', 'feed');
        await s.explorer.getOracleStats('1ExampleOracleAddress');

        expect(calls).to.deep.equal([
            '/bet_feeds/open/status',
            '/bet_feed/1234',
            '/bets/1234/feed',
            '/oracle/1ExampleOracleAddress'
        ]);
    });

    it('builds the bet_feed websocket subscription the way the server accepts it', function () {
        const WebSocketClient = require('../../../../src/clients/websocket.js');
        const sent = [];
        const client = Object.create(WebSocketClient.prototype);
        client.subscribe = (channels, params) => { sent.push(['sub', channels, params]); };
        client.unsubscribe = (channels, params) => { sent.push(['unsub', channels, params]); };

        client.subscribeBetFeed(1234);
        client.unsubscribeBetFeed('1234');

        // BARE channel name, market id in params, pinned against the composite
        // form `['bet_feed:1234']`, which the explorer rejects with
        // `Unknown channel` before it ever looks at the entity key: entity channels
        // are validated against a fixed name set and take their key from params
        // (ChannelManager). A mock-only test could assert either shape happily,
        // which is exactly how the wrong one shipped; test/sdk/betWebsocket.sdk.test.js
        // is the counterpart that talks to the real server.
        expect(sent).to.deep.equal([
            ['sub',   ['bet_feed'], { action_index: '1234' }],
            ['unsub', ['bet_feed'], { action_index: '1234' }],
        ]);

        // Caller params survive alongside the id rather than being replaced.
        sent.length = 0;
        client.subscribeBetFeed(7, { types: ['BET'] });
        expect(sent).to.deep.equal([['sub', ['bet_feed'], { types: ['BET'], action_index: '7' }]]);

        // A bad index would subscribe to a channel that never fires, and the
        // page would just sit there looking live.
        expect(() => client.subscribeBetFeed('abc')).to.throw(/numeric ACTION_INDEX/);
        expect(() => client.subscribeBetFeed(null)).to.throw(/numeric ACTION_INDEX/);
    });

});

describe('BET client surfaces', function () {

    it('exposes betting on the sdk instance and a raw bet() wrapper', async function () {
        const s = sdk();
        expect(s.betting).to.be.an('object');
        expect(s.getActions()).to.include('BET');
        expect(s.getActionFormats('BET')).to.have.keys(['0', '1', '2', '3']);
        const result = await s.bet({ version: 1, feedActionIndex: 1234 });
        expect(result.actionString).to.equal('BET|1|1234');
    });

    it('wires the workflow recipes to the pinned-version builders', function () {
        const s = sdk();
        for (const name of ['openMarket', 'placeBet', 'resolveMarket', 'cancelMarket'])
            expect(s.workflows[name]).to.be.a('function', name);
    });

});

describe('BET client surfaces', function () {

    describe('projectFeedCreateFee (decision F duration pricing)', function () {
        const DAY = 86400;
        const days = n => Math.round(n * DAY);

        it('matches the §10 value table', function () {
            const b = new BettingHelpers();
            // Quoted from the protocol reference, and verified on-chain by the P6 E9 drill
            // against fees.xchain_amount.
            const table = [
                [44,  '0.00000000'],   // inside the 90-day free window
                [90,  '0.00000000'],   // the boundary itself is still free
                [91,  '0.00550000'],
                [120, '0.16500000'],
                [365, '1.51250000'],
                [730, '3.52000000']    // both maxima: 1y deadline + 1y refund window
            ];
            for (const [d, fee] of table)
                expect(b.projectFeedCreateFee({ durationSeconds: days(d) }).fee, `${d} days`).to.equal(fee);
        });

        it('rounds the day count HALF-UP, never flooring', function () {
            const b = new BettingHelpers();
            // The consensus trap. On-chain the count is bcdiv(seconds, 86400, 0),
            // which rounds half-up: 90.4 -> 90 (free), 90.5 -> 91 (charged). A
            // projection that floored would call all three of these free and
            // under-quote the user by a full day's fee.
            expect(b.projectFeedCreateFee({ durationSeconds: days(90.4) }).free, '90.4 days').to.equal(true);
            expect(b.projectFeedCreateFee({ durationSeconds: days(90.5) }).fee, '90.5 days').to.equal('0.00550000');
            expect(b.projectFeedCreateFee({ durationSeconds: days(90.6) }).fee, '90.6 days').to.equal('0.00550000');
        });

        it('measures the feed\'s full life, not the deadline', function () {
            const b = new BettingHelpers();
            const blockTime = 1_700_000_000;
            // A 90-day DEADLINE with a 3600s refund window is a 90-day life and
            // free; the same deadline with a one-year window is not. Pricing off
            // DEADLINE alone would call both free.
            const short = b.projectFeedCreateFee({
                deadline: blockTime + days(90) - 3600, refundWindow: 3600, blockTime });
            expect(short.free, 'short refund window stays inside the free window').to.equal(true);

            const long = b.projectFeedCreateFee({
                deadline: blockTime + days(90), refundWindow: days(365), blockTime });
            expect(long.days, 'life spans deadline + refund window').to.equal(455);
            expect(long.fee, '(455 - 90) x 550 x 0.00001').to.equal('2.00750000');
        });
    });

});

describe('BET client surfaces', function () {

    describe('projectFeedCreateFee (decision F duration pricing)', function () {
        const DAY = 86400;
        const days = n => Math.round(n * DAY);

        it('reports the breakdown a wallet needs to explain the charge', function () {
            const b = new BettingHelpers();
            const p = b.projectFeedCreateFee({ durationSeconds: days(120) });
            expect(p.days).to.equal(120);
            expect(p.billableDays).to.equal(30);
            expect(p.free).to.equal(false);
            expect(p.durationSeconds).to.equal(days(120));
        });

        it('honours per-chain schedule overrides', function () {
            const b = new BettingHelpers();
            const p = b.projectFeedCreateFee({
                durationSeconds: days(100), freeDays: 0, perDay: 1000, gasPrice: '0.001' });
            expect(p.fee, '100 x 1000 x 0.001').to.equal('100.00000000');
        });

        it('rejects a market with no life and demands usable inputs', function () {
            const b = new BettingHelpers();
            expect(() => b.projectFeedCreateFee({ durationSeconds: 0 })).to.throw(/positive number of seconds/);
            expect(() => b.projectFeedCreateFee({})).to.throw(/durationSeconds/);
        });
    });

});
