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
const { agentOptsFor, NETWORK_MAP } = require('../../../../src/clients/hub/config_envelope');

describe('config_envelope agentOptsFor', () => {
    const httpsAgent = { id: 'https' };
    const httpAgent = { id: 'http' };

    it('returns only proxy:false for a null pool', () => {
        assert.deepStrictEqual(agentOptsFor('https://hub.test', null), { proxy: false });
    });

    it('returns only proxy:false when the matching agent is missing', () => {
        assert.deepStrictEqual(agentOptsFor('https://hub.test', { httpAgent }), { proxy: false });
        assert.deepStrictEqual(agentOptsFor('http://hub.test', { httpsAgent }), { proxy: false });
    });

    it('passes the https agent by reference for https urls', () => {
        const opts = agentOptsFor('https://hub.test', { httpsAgent, httpAgent });
        assert.strictEqual(opts.httpsAgent, httpsAgent);
        assert.strictEqual(opts.proxy, false);
        assert.ok(!('httpAgent' in opts));
    });

    it('passes the http agent by reference for http urls', () => {
        const opts = agentOptsFor('http://hub.test', { httpsAgent, httpAgent });
        assert.strictEqual(opts.httpAgent, httpAgent);
        assert.strictEqual(opts.proxy, false);
        assert.ok(!('httpsAgent' in opts));
    });
});

describe('config_envelope NETWORK_MAP', () => {
    const coins = ['bitcoin', 'litecoin', 'dogecoin'];
    const nets = ['mainnet', 'testnet', 'regtest'];

    it('has exactly the nine coin-network keys', () => {
        const expected = coins.flatMap(c => nets.map(n => `${c}-${n}`));
        assert.deepStrictEqual(Object.keys(NETWORK_MAP).sort(), expected.sort());
    });

    it('maps each key to its coin and network words', () => {
        for (const c of coins) {
            for (const n of nets) {
                assert.deepStrictEqual(NETWORK_MAP[`${c}-${n}`], { coin: c, network: n });
            }
        }
        assert.deepStrictEqual(NETWORK_MAP['bitcoin-regtest'], { coin: 'bitcoin', network: 'regtest' });
    });
});
