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
     *  Constructor
     */

    describe('constructor', function () {
        it('defaults to localhost:10000', function () {
            let hub = new HubConnector();
            assert.strictEqual(hub.url, 'http://localhost:10000');
            assert.deepStrictEqual(hub.urls, ['http://localhost:10000']);
        });

        it('uses hubUrl + hubPort', function () {
            let hub = new HubConnector({ hubUrl: 'hub.test', hubPort: 9000 });
            assert.strictEqual(hub.url, 'http://hub.test:9000');
        });

        it('prepends http:// when missing', function () {
            let hub = new HubConnector({ hubUrl: 'hub.test', hubPort: 8001 });
            assert.ok(hub.url.startsWith('http://'));
        });

        it('keeps http:// prefix from hubUrl as-is', function () {
            let hub = new HubConnector({ hubUrl: 'http://custom.test', hubPort: 9999 });
            assert.strictEqual(hub.url, 'http://custom.test');
        });

        it('uses hubValidators array when provided', function () {
            let hub = new HubConnector({
                hubValidators: ['hub1.test:8001', 'http://hub2.test:8001']
            });
            assert.strictEqual(hub.urls.length, 2);
            assert.ok(hub.urls[0].startsWith('http://'));
            assert.ok(hub.urls[1].startsWith('http://'));
            assert.strictEqual(hub.url, hub.urls[0]);
        });

        it('falls back to hubUrl when hubValidators is empty array', function () {
            let hub = new HubConnector({ hubValidators: [], hubUrl: 'fallback.test', hubPort: 8001 });
            assert.strictEqual(hub.urls.length, 1);
        });

        it('falls back to hubUrl when hubValidators is not an array', function () {
            let hub = new HubConnector({ hubValidators: 'not-an-array', hubUrl: 'fallback.test', hubPort: 8001 });
            assert.strictEqual(hub.urls.length, 1);
        });
    });
});

describe('HubConnector', function () {

    afterEach(function () {
        nock.cleanAll();
    });

    describe('constructor', function () {
        it('sets default timeout to 5000', function () {
            let hub = new HubConnector();
            assert.strictEqual(hub.timeout, 5000);
        });

        it('accepts custom timeout', function () {
            let hub = new HubConnector({ timeout: 10000 });
            assert.strictEqual(hub.timeout, 10000);
        });

        it('sets default pollInterval to 60000', function () {
            let hub = new HubConnector();
            assert.strictEqual(hub.pollInterval, 60000);
        });

        it('accepts custom pollInterval', function () {
            let hub = new HubConnector({ hubPollInterval: 30000 });
            assert.strictEqual(hub.pollInterval, 30000);
        });

        it('initializes configs as null and lastSeq as 0', function () {
            let hub = new HubConnector();
            assert.strictEqual(hub.configs, null);
            assert.strictEqual(hub.lastSeq, 0);
            assert.strictEqual(hub.lastWatermark, 0);
        });
    });
});
