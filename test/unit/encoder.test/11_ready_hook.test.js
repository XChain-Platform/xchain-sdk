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
const sinon = require('sinon');
const EncoderClient = require('../../../src/clients/encoder.js');

describe('EncoderClient', function () {
    const BASE = 'http://encoder.test:3000';

    afterEach(function () {
        nock.cleanAll();
    });

    describe('readyHook', function () {
        afterEach(function () {
            sinon.restore();
        });

        it('awaits readyHook before each RPC call', async function () {
            let hookCalled = false;
            const readyHook = async () => { hookCalled = true; };
            const hooked = new EncoderClient({
                encoderUrl: 'encoder.test',
                encoderPort: 3000,
                retry: false,
                readyHook
            });
            nock(BASE)
                .post('/')
                .reply(200, { jsonrpc: '2.0', result: { status: 'ok' }, id: 1 });

            await hooked.ping();
            expect(hookCalled).to.be.true;
        });
    });
});
