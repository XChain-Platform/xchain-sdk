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
const EncoderClient = require('../../../src/clients/encoder.js');

describe('EncoderClient', function () {
    describe('HTTPS base URL', function () {
        it('builds client with https agent when url starts with https', function () {
            const hooked = new EncoderClient({
                encoderUrl: 'https://encoder.example.com',
                encoderPort: 443
            });
            expect(hooked.client.defaults.baseURL).to.equal('https://encoder.example.com');
        });
    });
});
