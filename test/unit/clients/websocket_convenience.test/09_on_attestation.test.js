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
const { waitForCalls } = require('../../../helpers/wait.js');
const { closeFixture, createFixture, passBarrier } = require('./support/setup.js');

let server, sdk;

function registerHooks() {
    beforeEach(async function () {
        ({ server, sdk } = await createFixture());
    });
    afterEach(function (done) {
        closeFixture(sdk, server, done);
    });
}

async function barrier() {
    await passBarrier(sdk, server);
}

describe('XChainSDK – WebSocket convenience methods', function () {
    registerHooks();

    describe('onAttestation', function () {

        it('fires on both attestation phases', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            sdk.onAttestation(spy);

            server._lastClient.send(JSON.stringify({
                type: 'ATTESTATION_REQUEST', data: { action_index: 901, version: 0, request_id: 'r1' }
            }));
            server._lastClient.send(JSON.stringify({
                type: 'ATTESTATION_RESPONSE', data: { action_index: 902, version: 1, request_id: 'r1' }
            }));
            await waitForCalls(spy, 2);

            expect(spy.getCalls().map(c => c.args[0].type))
                .to.deep.equal(['ATTESTATION_REQUEST', 'ATTESTATION_RESPONSE']);
        });

        it('unsubscribe removes both handlers', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            const unsub = sdk.onAttestation(spy);
            unsub();

            server._lastClient.send(JSON.stringify({
                type: 'ATTESTATION_REQUEST', data: { action_index: 901, version: 0 }
            }));
            server._lastClient.send(JSON.stringify({
                type: 'ATTESTATION_RESPONSE', data: { action_index: 902, version: 1 }
            }));
            await barrier();

            expect(spy.called).to.be.false;
        });
    });

});
