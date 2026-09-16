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

    describe('public methods', function () {
        it('has 12 public methods', function () {
            let methods = Object.getOwnPropertyNames(Object.getPrototypeOf(client))
                .filter(m => !m.startsWith('_') && m !== 'constructor');
            // 12 = 9 + the three transport helpers that dropped their underscore:
            // buildClient, rpc, handleError.
            expect(methods).to.have.length(12);
            expect(methods).to.include('ping');
            expect(methods).to.include('createTx');
            expect(methods).to.include('spendP2sh');
            expect(methods).to.include('broadcastTx');
            expect(methods).to.include('getUTXOs');
            expect(methods).to.include('estimateFee');
            expect(methods).to.include('setBase');
            expect(methods).to.include('health');
            expect(methods).to.include('getFeeTiers');
        });
    });
});
