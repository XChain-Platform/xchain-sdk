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
const nock = require('nock');
const EncoderClient = require('../../../src/clients/encoder.js');

describe('EncoderClient', function () {
    const BASE = 'http://encoder.test:3000';

    afterEach(function () {
        nock.cleanAll();
    });

    describe('retry=false', function () {
        it('does not retry when retry is false', async function () {
            const hooked = new EncoderClient({
                encoderUrl: 'encoder.test',
                encoderPort: 3000,
                retry: false
            });

            // Only intercept one call; if retried, nock would throw unmatched request
            nock(BASE)
                .post('/')
                .reply(503, 'Service Unavailable');

            try {
                await hooked.ping();
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.name).to.equal('SDKEncoderError');
                expect(e.code).to.equal('ENCODER_HTTP_503');
            }
        });
    });
});
