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
const sinon = require('sinon');
const EncoderClient = require('../../../src/clients/encoder.js');

describe('EncoderClient', function () {
    describe('timeout errors', function () {
        afterEach(function () {
            sinon.restore();
        });

        it('wraps ECONNABORTED as ENCODER_TIMEOUT', async function () {
            // Use a no-retry client so the test completes immediately
            const noRetry = new EncoderClient({
                encoderUrl: 'encoder.test',
                encoderPort: 3000,
                retry: false
            });
            const err = new Error('timeout of 30000ms exceeded');
            err.code = 'ECONNABORTED';
            sinon.stub(noRetry.client, 'post').rejects(err);
            try {
                await noRetry.ping();
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.name).to.equal('SDKEncoderError');
                expect(e.code).to.equal('ENCODER_TIMEOUT');
                expect(e.details.timeout).to.equal(noRetry.timeout);
            }
        });
    });
});
