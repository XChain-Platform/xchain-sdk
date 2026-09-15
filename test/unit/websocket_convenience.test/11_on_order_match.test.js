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
 * Unit tests for XChainSDK WebSocket convenience methods
 *
 * Tests onBlock, onAddress, onCoinpayRequired, onOrderMatch, etc.
 */

'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const { waitForCalls } = require('../../helpers/wait.js');
const { closeFixture, createFixture } = require('./support/setup.js');

let server, sdk;

function registerHooks() {
    beforeEach(async function () {
        ({ server, sdk } = await createFixture());
    });
    afterEach(function (done) {
        closeFixture(sdk, server, done);
    });
}

describe('XChainSDK – WebSocket convenience methods', function () {
    registerHooks();

    describe('onOrderMatch', function () {

        it('fires on ORDER_MATCH', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            sdk.onOrderMatch('1abc', spy);

            server._lastClient.send(JSON.stringify({
                type: 'ORDER_MATCH', data: { action_index: 501, settlement_type: 'coinpay' }
            }));
            await waitForCalls(spy);

            expect(spy.calledOnce).to.be.true;
        });
    });
});
