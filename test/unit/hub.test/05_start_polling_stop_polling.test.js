// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const nock = require('nock');
const HubConnector = require('../../../src/clients/hub.js');

describe('HubConnector', function () {

    afterEach(function () {
        nock.cleanAll();
    });

    /*
     *  startPolling() / stopPolling()
     */

    describe('startPolling() / stopPolling()', function () {
        it('stopPolling() is a no-op when not started', function () {
            let hub = new HubConnector();
            assert.doesNotThrow(() => hub.stopPolling());
            assert.strictEqual(hub._pollTimer, null);
        });

        it('startPolling() sets _pollTimer', function () {
            let hub = new HubConnector({ hubPollInterval: 60000 });
            // stub getAllConfig so it doesn't actually hit the net
            hub.getAllConfig = async () => ({});
            hub.startPolling();
            assert.ok(hub._pollTimer !== null);
            hub.stopPolling();
        });

        it('startPolling() is idempotent (does not double-start)', function () {
            let hub = new HubConnector({ hubPollInterval: 60000 });
            hub.getAllConfig = async () => ({});
            hub.startPolling();
            let t1 = hub._pollTimer;
            hub.startPolling(); // second call is a no-op
            assert.strictEqual(hub._pollTimer, t1);
            hub.stopPolling();
        });

        it('stopPolling() clears the timer', function () {
            let hub = new HubConnector({ hubPollInterval: 60000 });
            hub.getAllConfig = async () => ({});
            hub.startPolling();
            hub.stopPolling();
            assert.strictEqual(hub._pollTimer, null);
        });
    });
});
