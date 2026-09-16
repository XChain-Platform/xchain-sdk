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
 * XChain Platform SDK - Retry Logic & Request Hooks Tests
 *
 ********************************************************************/

const { expect } = require('chai');
const nock = require('nock');
const ExplorerClient = require('../../../../src/clients/explorer.js');


// Explorer retry integration tests

function registerSuccessfulRetryTests(getClient, explorerBase) {
    it('HTTP 503 then 200: succeeds', async () => {
        nock(explorerBase)
            .get('/BTC/api/status').reply(503)
            .get('/BTC/api/status').reply(200, { ok: true });

        let result = await getClient().getStatus();
        expect(result).to.deep.equal({ ok: true });
    });

    it('HTTP 429 then 200: succeeds', async () => {
        nock(explorerBase)
            .get('/BTC/api/status').reply(429)
            .get('/BTC/api/status').reply(200, { ok: true });

        let result = await getClient().getStatus();
        expect(result).to.deep.equal({ ok: true });
    });
}

function registerExplorerFailureTests(getClient, explorerBase) {
    it('HTTP 503 three times: throws SDKExplorerError (maxRetries: 2 = 3 total attempts)', async () => {
        nock(explorerBase)
            .get('/BTC/api/status').reply(503)
            .get('/BTC/api/status').reply(503)
            .get('/BTC/api/status').reply(503);

        let thrown;
        try {
            await getClient().getStatus();
        } catch (e) {
            thrown = e;
        }
        expect(thrown).to.exist;
        expect(thrown.name).to.equal('SDKExplorerError');
        expect(thrown.code).to.equal('EXPLORER_HTTP_503');
    });

    it('HTTP 400: throws immediately, no retry', async () => {
        // Only one nock scope; a retry would cause nock to throw "Nock: No match" (test would fail differently)
        nock(explorerBase)
            .get('/BTC/api/status').reply(400, { error: 'bad request' });

        let thrown;
        try {
            await getClient().getStatus();
        } catch (e) {
            thrown = e;
        }
        expect(thrown).to.exist;
        expect(thrown.name).to.equal('SDKExplorerError');
        expect(thrown.code).to.equal('EXPLORER_HTTP_400');
    });
}

function registerDisabledRetryTest(explorerBase) {
    it('retry: false, HTTP 503 throws immediately without retry', async () => {
        let noRetryClient = new ExplorerClient({
            network:     'bitcoin-mainnet',
            explorerUrl: 'retry.test',
            explorerPort: 8080,
            retry: false
        });

        nock(explorerBase)
            .get('/BTC/api/status').reply(503);

        let thrown;
        try {
            await noRetryClient.getStatus();
        } catch (e) {
            thrown = e;
        }
        expect(thrown).to.exist;
        expect(thrown.name).to.equal('SDKExplorerError');
        expect(thrown.code).to.equal('EXPLORER_HTTP_503');
    });
}

describe('ExplorerClient retry integration', () => {
    const EXPLORER_BASE = 'http://retry.test:8080';
    let client;

    beforeEach(() => {
        client = new ExplorerClient({
            network:     'bitcoin-mainnet',
            explorerUrl: 'retry.test',
            explorerPort: 8080,
            retry: { maxRetries: 2, baseDelay: 50 }
        });
    });

    afterEach(() => {
        nock.cleanAll();
    });

    registerSuccessfulRetryTests(() => client, EXPLORER_BASE);
    registerExplorerFailureTests(() => client, EXPLORER_BASE);
    registerDisabledRetryTest(EXPLORER_BASE);

});
