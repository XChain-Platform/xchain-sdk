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
 *
 * XChain Platform SDK - Hub Config Hostile Key Tests
 *
 * A hub reply is remote JSON, so a "__proto__" or "constructor" key in it must
 * never reach Object.prototype or a built-in through the config tree.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const nock = require('nock');
const HubConnector = require('../../../../src/clients/hub.js');
const { mergeConfigDelta } = require('../../../../src/clients/hub/config_envelope.js');

const MARK = 'pollutedByHubTest';
const HUB_BASE = 'http://localhost:10000';
const REGISTRY_PATH = '/api/v1/chain-registry';

// Drop any marker a failing case leaked, so one red case cannot poison the rest.
function scrubMarkers() {
    delete Object.prototype[MARK];
    delete Object[MARK];
    delete Object.prototype.toString[MARK];
}

function assertClean() {
    assert.strictEqual(({})[MARK], undefined, 'Object.prototype gained the marker');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(Object.prototype, MARK), false);
    assert.strictEqual(Object[MARK], undefined, 'the Object constructor gained the marker');
    assert.strictEqual(Object.prototype.toString[MARK], undefined, 'a built-in gained the marker');
}

describe('config_envelope mergeConfigDelta hostile keys', function () {
    afterEach(scrubMarkers);

    it('ignores __proto__ at the coin, network, module and param levels', function () {
        const levels = [
            '{"__proto__":{"' + MARK + '":{"m":{"p":1}}}}',
            '{"bitcoin":{"__proto__":{"' + MARK + '":{"p":1}}}}',
            '{"bitcoin":{"mainnet":{"__proto__":{"' + MARK + '":1}}}}',
            '{"bitcoin":{"mainnet":{"rpc":{"__proto__":{"' + MARK + '":1}}}}}'
        ];
        for (const json of levels) {
            const base = {};
            mergeConfigDelta(base, JSON.parse(json));
            assertClean();
            if (base.bitcoin && base.bitcoin.mainnet && base.bitcoin.mainnet.rpc)
                assert.strictEqual(Object.getPrototypeOf(base.bitcoin.mainnet.rpc), Object.prototype);
        }
    });

    it('ignores constructor and prototype keys', function () {
        const base = {};
        mergeConfigDelta(base, JSON.parse(
            '{"constructor":{"' + MARK + '":{"m":{"p":1}}},"prototype":{"x":{"m":{"p":1}}}}'));
        assertClean();
        assert.deepStrictEqual(Object.keys(base), []);
    });

    it('gives an inherited name such as toString its own plain level', function () {
        const base = {};
        mergeConfigDelta(base, JSON.parse('{"toString":{"' + MARK + '":{"m":{"p":1}}}}'));
        assertClean();
        assert.ok(Object.prototype.hasOwnProperty.call(base, 'toString'));
        assert.deepStrictEqual(base.toString[MARK], { m: { p: 1 } });
    });

    it('still merges a legitimate sibling in the same hostile delta', function () {
        const base = { bitcoin: { mainnet: { rpc: { host: 'a', port: 1 } } } };
        mergeConfigDelta(base, JSON.parse(
            '{"__proto__":{"' + MARK + '":{"m":{"p":1}}},"bitcoin":{"mainnet":{"rpc":{"host":"b"}}}}'));
        assertClean();
        assert.deepStrictEqual(base, { bitcoin: { mainnet: { rpc: { host: 'b', port: 1 } } } });
    });

    it('copies nothing out of a non-object delta level and does not throw', function () {
        const base = { bitcoin: { mainnet: { rpc: { host: 'a' } } } };
        mergeConfigDelta(base, { litecoin: null, dogecoin: [1, 2], bitcoin: { mainnet: { rpc: 7 } } });
        assert.deepStrictEqual(base.bitcoin, { mainnet: { rpc: { host: 'a' } } });
        assert.deepStrictEqual(base.litecoin, {});
        assert.deepStrictEqual(base.dogecoin, {});
    });
});

describe('public hub discovery hostile descriptors', function () {
    let savedHubApiKey;

    beforeEach(function () {
        savedHubApiKey = process.env.HUB_API_KEY;
        delete process.env.HUB_API_KEY;
    });

    afterEach(function () {
        nock.cleanAll();
        scrubMarkers();
        if (savedHubApiKey === undefined) delete process.env.HUB_API_KEY;
        else process.env.HUB_API_KEY = savedHubApiKey;
    });

    function descriptor(coin, networkKind) {
        return {
            id: coin + '-' + networkKind,
            coin,
            networkKind,
            explorer: { defaultUrl: 'https://explorer.test' },
            encoder: { defaultUrl: 'https://encoder.test/BTC' }
        };
    }

    for (const [coin, networkKind] of [['__proto__', MARK], ['constructor', MARK], ['bitcoin', '__proto__']]) {
        it('refuses a registry reply whose descriptor keys on ' + coin + '/' + networkKind, async function () {
            const body = '{"descriptors":[' + JSON.stringify(descriptor('bitcoin', 'mainnet')) + ',' +
                JSON.stringify(descriptor(coin, networkKind)) + ']}';
            nock(HUB_BASE).get(REGISTRY_PATH)
                .reply(200, body, { 'Content-Type': 'application/json' });

            const hub = new HubConnector({ hubValidators: [HUB_BASE + '/BTC'] });
            await assert.rejects(
                hub.getDiscoveryConfig(),
                err => err.name === 'SDKHubError' && err.code === 'HUB_UNAVAILABLE'
            );
            assertClean();
            assert.strictEqual(hub.configs, null);
        });
    }
});
