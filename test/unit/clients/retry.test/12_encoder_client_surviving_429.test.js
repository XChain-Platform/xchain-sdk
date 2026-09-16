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
const { SDKRateLimitedError } = require('../../../../src/utils/errors.js');

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

        it('429 then 200: the retry is honoured and the caller sees nothing', async function () {
            nock(ENCODER_BASE)
                .post('/').reply(429, { error: 'slow down' }, { 'Retry-After': '30' })
                .post('/').reply(200, { jsonrpc: '2.0', id: 2, result: 'pong' });

            expect(await makeClient().ping()).to.equal('pong');
        });

        it('429 then 429: throws SDKRateLimitedError carrying the seconds', async function () {
            nock(ENCODER_BASE)
                .post('/').reply(429, { error: 'slow down' }, { 'Retry-After': '30' })
                .post('/').reply(429, { error: 'slow down' }, { 'Retry-After': '30' });

            let thrown;
            try {
                await makeClient().ping();
            } catch (e) { thrown = e; }

            expect(thrown).to.exist;
            expect(thrown.name).to.equal('SDKRateLimitedError');
            expect(thrown).to.be.instanceof(SDKRateLimitedError);
            expect(thrown.code).to.equal('RATE_LIMITED');
            expect(thrown.service).to.equal('encoder');
            expect(thrown.status).to.equal(429);
            expect(thrown.retryAfterSeconds).to.equal(30);
            expect(thrown.message).to.equal('Encoder returned HTTP 429 for method ping; retry after 30 seconds');
            expect(thrown.details.method).to.equal('ping');
        });

    });

});
