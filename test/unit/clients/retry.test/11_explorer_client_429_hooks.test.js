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
const { SDKExplorerError } = require('../../../../src/utils/errors.js');

describe('retry: the 429 path', function () {

    describe('(e) ExplorerClient on a surviving 429', function () {

        const EXPLORER_BASE = 'http://ratelimit.test:8080';

        function makeClient() {
            // retryAfterMaxDelay: 20 keeps the honoured wait at 20 ms in-test
            // while the header still says 30 s, so the reported seconds and the
            // cap are exercised independently.
            return new ExplorerClient({
                network:      'bitcoin-mainnet',
                explorerUrl:  'ratelimit.test',
                explorerPort: 8080,
                retry: { maxRetries: 2, baseDelay: 10, retryAfterMaxDelay: 20 }
            });
        }

        afterEach(() => nock.cleanAll());

        it('a 503 is unaffected: still SDKExplorerError with the HTTP code', async function () {
            nock(EXPLORER_BASE)
                .get('/BTC/api/status').reply(503)
                .get('/BTC/api/status').reply(503)
                .get('/BTC/api/status').reply(503);

            let thrown;
            try {
                await makeClient().getStatus();
            } catch (e) { thrown = e; }
            expect(thrown).to.be.instanceof(SDKExplorerError);
            expect(thrown.code).to.equal('EXPLORER_HTTP_503');
        });

        it('the onRetry hook payload carries the status', async function () {
            const seen = [];
            const client = new ExplorerClient({
                network:      'bitcoin-mainnet',
                explorerUrl:  'ratelimit.test',
                explorerPort: 8080,
                retry: { maxRetries: 2, baseDelay: 10, retryAfterMaxDelay: 20 },
                hooks: { onRetry: (info) => seen.push(info) }
            });

            nock(EXPLORER_BASE)
                .get('/BTC/api/status').reply(429, {}, { 'Retry-After': '30' })
                .get('/BTC/api/status').reply(200, { ok: true });

            await client.getStatus();
            expect(seen).to.have.lengthOf(1);
            expect(seen[0].status).to.equal(429);
            expect(seen[0].service).to.equal('explorer');
        });

    });

});
