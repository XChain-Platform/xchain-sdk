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
    let client;

    beforeEach(function () {
        client = new EncoderClient({ encoderUrl: 'encoder.test', encoderPort: 3000 });
    });

    describe('setBase', function () {
        it('no-ops when both url and port are falsy', function () {
            const origClient = client.client;
            client.setBase(null, null);
            expect(client.client).to.equal(origClient);
        });

        it('no-ops when url/port unchanged', function () {
            const origClient = client.client;
            client.setBase('encoder.test', 3000);
            expect(client.client).to.equal(origClient);
        });

        it('rebuilds client when url changes', function () {
            const origClient = client.client;
            client.setBase('new-encoder.test', 3000);
            expect(client.client).to.not.equal(origClient);
            expect(client.baseUrl).to.equal('new-encoder.test');
        });

        it('rebuilds client when port changes', function () {
            const origClient = client.client;
            client.setBase('encoder.test', 4000);
            expect(client.client).to.not.equal(origClient);
            expect(client.port).to.equal(4000);
        });
    });
});
