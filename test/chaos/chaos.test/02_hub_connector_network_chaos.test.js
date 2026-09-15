'use strict';

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
 *
 * XChain Platform SDK - Network Chaos Tests
 *
 * Verifies that all network clients (ExplorerClient, EncoderClient,
 * HubConnector) wrap every failure mode as a typed SDK error and
 * never surface raw network/axios errors to the caller.
 *
 ********************************************************************/

const { expect } = require('chai');
const nock = require('nock');
const HubConnector = require('../../../src/clients/hub.js');
const { SDKHubError } = require('../../../src/utils/errors.js');

function makeHub(extraOpts = {}) {
    return new HubConnector(Object.assign({
        hubUrl:  'chaos.test',
        hubPort: 8001,
        retry: false
    }, extraOpts));
}

const HUB_BASE = 'http://chaos.test:8001';

// 3. HUB CHAOS (6 tests)

describe('HubConnector – network chaos', function () {
    this.timeout(5000);

    before(() => nock.disableNetConnect());
    after(() => nock.enableNetConnect());
    afterEach(() => nock.cleanAll());

    // (a) Hub returns empty config
    it('a) empty config result – getAllConfig returns null; extractServiceEndpoints returns {}', async () => {
        nock(HUB_BASE)
            .post('/')
            .reply(200, { jsonrpc: '2.0', result: {}, id: 1 });

        const hub = makeHub();
        // result is {} which is truthy, so getAllConfig stores and returns it
        const config = await hub.getAllConfig();
        expect(config).to.deep.equal({});

        // With an empty config object, extractServiceEndpoints should return {}
        const endpoints = hub.extractServiceEndpoints('bitcoin-mainnet');
        expect(endpoints).to.deep.equal({});
    });

    // (b) Hub returns malformed config structure (coin value is a string, not an object)
    it('b) malformed config structure – extractServiceEndpoints does not crash', async () => {
        nock(HUB_BASE)
            .post('/')
            .reply(200, { jsonrpc: '2.0', result: { bitcoin: 'not an object' }, id: 1 });

        const hub = makeHub();
        await hub.getAllConfig();

        // coinConfig['mainnet'] on a string is undefined → should return {}
        const endpoints = hub.extractServiceEndpoints('bitcoin-mainnet');
        expect(endpoints).to.deep.equal({});
    });

});

describe('HubConnector – network chaos', function () {
    this.timeout(5000);

    before(() => nock.disableNetConnect());
    after(() => nock.enableNetConnect());
    afterEach(() => nock.cleanAll());

    // (c) Hub returns null result
    //
    // This asserted `getAllConfig() === null` back when a single hub URL either
    // answered or returned null. Multi-endpoint failover changed the contract:
    // a null result is a failed endpoint, the loop moves to the next one, and
    // when every endpoint is exhausted the call raises HUB_UNAVAILABLE rather
    // than handing back a null the caller would have to re-check. A silent null
    // is exactly what the failover exists to stop, so assert the refusal.
    it('c) null result – getAllConfig exhausts the endpoints and throws HUB_UNAVAILABLE', async () => {
        nock(HUB_BASE)
            .post('/')
            .reply(200, { jsonrpc: '2.0', result: null, id: 1 });

        const hub = makeHub();
        let caught = null;
        try {
            await hub.getAllConfig();
        } catch (err) {
            caught = err;
        }
        expect(caught, 'a null result must not resolve silently').to.not.equal(null);
        expect(caught.code).to.equal('HUB_UNAVAILABLE');
        expect(caught.message).to.match(/no result/);
    });

});

describe('HubConnector – network chaos', function () {
    this.timeout(5000);

    before(() => nock.disableNetConnect());
    after(() => nock.enableNetConnect());
    afterEach(() => nock.cleanAll());

    // (d) Hub unreachable (ECONNREFUSED)
    it('d) hub unreachable – throws SDKHubError with code HUB_UNAVAILABLE', async () => {
        nock(HUB_BASE)
            .post('/')
            .replyWithError('ECONNREFUSED');

        const hub = makeHub();
        try {
            await hub.getAllConfig();
            throw new Error('Expected SDKHubError but call succeeded');
        } catch (err) {
            expect(err).to.be.instanceof(SDKHubError);
            expect(err.code).to.equal('HUB_UNAVAILABLE');
        }
    });

    // (e) Hub timeout
    // NOTE: nock .delay() + axios timeout interaction can be timing-sensitive in CI.
    it('e) hub timeout – throws SDKHubError', async () => {
        nock(HUB_BASE)
            .post('/')
            .delay(10000)
            .reply(200, {});

        // Pass timeout via constructor options; HubConnector reads options.timeout
        const hub = makeHub({ timeout: 100 });
        try {
            await hub.getAllConfig();
            throw new Error('Expected SDKHubError but call succeeded');
        } catch (err) {
            expect(err).to.be.instanceof(SDKHubError);
        }
    });

    // (f) ping returns false on network failure, does not throw
    it('f) ping – returns false on failure, does not throw', async () => {
        nock(HUB_BASE)
            .post('/')
            .replyWithError('fail');

        const hub = makeHub();
        const result = await hub.ping();
        expect(result).to.equal(false);
    });

});
