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
const EncoderClient = require('../../../../src/clients/encoder.js');
const { SDKEncoderError } = require('../../../../src/utils/errors.js');

describe('retry: the 429 path', function () {

    describe('(f) EncoderClient on a surviving 429', function () {

        const ENCODER_BASE = 'http://ratelimit.test:3000';

        function makeClient() {
            return new EncoderClient({
                encoderUrl:  'ratelimit.test',
                encoderPort: 3000,
                retry: { maxRetries: 2, baseDelay: 10, retryAfterMaxDelay: 20 }
            });
        }

        afterEach(() => nock.cleanAll());

        it('a 500 is unaffected: still SDKEncoderError with the HTTP code', async function () {
            nock(ENCODER_BASE).post('/').reply(500, { error: 'internal' });

            let thrown;
            try {
                await makeClient().ping();
            } catch (e) { thrown = e; }
            expect(thrown).to.be.instanceof(SDKEncoderError);
            expect(thrown.code).to.equal('ENCODER_HTTP_500');
        });

        it('the onRetry hook payload carries the status', async function () {
            const seen = [];
            const client = new EncoderClient({
                encoderUrl:  'ratelimit.test',
                encoderPort: 3000,
                retry: { maxRetries: 2, baseDelay: 10, retryAfterMaxDelay: 20 },
                hooks: { onRetry: (info) => seen.push(info) }
            });

            nock(ENCODER_BASE)
                .post('/').reply(429, {}, { 'Retry-After': '30' })
                .post('/').reply(200, { jsonrpc: '2.0', id: 2, result: 'pong' });

            await client.ping();
            expect(seen).to.have.lengthOf(1);
            expect(seen[0].status).to.equal(429);
            expect(seen[0].service).to.equal('encoder');
        });

    });

});
