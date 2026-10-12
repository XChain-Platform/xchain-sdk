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
const coins = require('../../../src/coins');
const {
    coinPrefix, coinTier, hasHttpScheme, isHttpsUrl, publicDefaults
} = require('../../../src/utils/endpoints.js');
const ExplorerClient  = require('../../../src/clients/explorer.js');
const EncoderClient   = require('../../../src/clients/encoder.js');
const HubConnector    = require('../../../src/clients/hub.js');
const WebSocketClient = require('../../../src/clients/websocket.js');
const { agentOptsFor } = require('../../../src/clients/hub/config_envelope.js');

// Inherited Object.prototype names and malformed shapes no network string may resolve.
const INHERITED = ['constructor-mainnet', '__proto__-mainnet', 'toString-testnet',
    'hasOwnProperty-regtest', 'bitcoin-constructor', 'bitcoin-__proto__', 'bitcoin-toString'];
const EXTRA_SEGMENTS = ['bitcoin-mainnet-x', 'bitcoin-mainnet-', 'bitcoin--mainnet'];

describe('endpoints strict network lookups', function () {
    it('coinPrefix returns null for inherited prototype names', function () {
        for (const network of INHERITED) expect(coinPrefix(network), network).to.equal(null);
    });

    it('coinPrefix returns null for extra segments', function () {
        for (const network of EXTRA_SEGMENTS) expect(coinPrefix(network), network).to.equal(null);
    });

    it('publicDefaults returns {} for an inherited name or extra segment', function () {
        expect(publicDefaults('constructor-mainnet')).to.deep.equal({});
        expect(publicDefaults('bitcoin-mainnet-x')).to.deep.equal({});
    });

    it('explorer client refuses inherited names and extra segments', function () {
        for (const network of ['constructor-mainnet', 'bitcoin-__proto__', 'bitcoin-mainnet-x'])
            expect(() => new ExplorerClient({ network }), network).to.throw(/Unknown network/);
    });

    it('websocket client refuses inherited names and extra segments', function () {
        for (const network of ['constructor', '__proto__', 'toString', 'bitcoin-mainnet-x'])
            expect(() => new WebSocketClient({ network }), network).to.throw(/Unknown network/);
    });

    it('websocket and explorer clients agree on every registry network', function () {
        for (const tick of coins.ALLOWED_COINS) {
            for (const net of coins.NETWORKS) {
                const network = coins.COIN_FULL_NAME[tick] + '-' + net;
                expect(new WebSocketClient({ network }).coin).to.equal(new ExplorerClient({ network }).coin);
            }
        }
        expect(new WebSocketClient({ network: 'dogecoin-testnet' }).coin).to.equal('TDOGE');
    });
});

describe('endpoints coin tier from the registry', function () {
    it('coinTier reads the tier letter of every registry coin code', function () {
        expect(coinTier('BTC')).to.equal('');
        expect(coinTier('TLTC')).to.equal('T');
        expect(coinTier('RDOGE')).to.equal('R');
        expect(coinTier('TFOO')).to.equal('');
    });

    it('siblingCoin keeps the tier for a coin added to the registry', function () {
        coins.ALLOWED_COINS.push('FOO');
        try {
            const client = new ExplorerClient({ network: 'bitcoin-testnet' });
            client.coin = 'TFOO';
            expect(client.siblingCoin('btc')).to.equal('TBTC');
            client.coin = 'RFOO';
            expect(client.fileRawUrl(5, 'DOGE')).to.match(/\/RDOGE\/api\/file\/5\/raw$/);
        } finally {
            coins.ALLOWED_COINS.pop();
        }
    });
});

describe('endpoints http scheme detection', function () {
    it('hasHttpScheme needs the scheme separator, not just an http prefix', function () {
        expect(hasHttpScheme('http://a')).to.equal(true);
        expect(hasHttpScheme('https://a')).to.equal(true);
        expect(hasHttpScheme('httpgw.internal')).to.equal(false);
        expect(hasHttpScheme('https-hub')).to.equal(false);
        expect(isHttpsUrl('https://a')).to.equal(true);
        expect(isHttpsUrl('https-hub')).to.equal(false);
    });

    it('a bare host starting with http gets a scheme and port on every client', function () {
        const ex = new ExplorerClient({ explorerUrl: 'httpgw.internal', explorerPort: 8080 });
        expect(ex.client.defaults.baseURL).to.equal('http://httpgw.internal:8080');
        expect(ex.fileRawUrl(1)).to.equal('http://httpgw.internal:8080/BTC/api/file/1/raw');
        const enc = new EncoderClient({ encoderUrl: 'https-enc', encoderPort: 3003 });
        expect(enc.client.defaults.baseURL).to.equal('http://https-enc:3003');
        expect(new HubConnector({ hubUrl: 'httpbin', hubPort: 10000 }).urls).to.deep.equal(['http://httpbin:10000']);
        expect(new HubConnector({ hubValidators: ['https-hub:10000'] }).urls).to.deep.equal(['http://https-hub:10000']);
    });

    it('full http and https URLs are still used verbatim', function () {
        const ex = new ExplorerClient({ explorerUrl: 'https://explorer.xchain.io', explorerPort: 8080 });
        expect(ex.client.defaults.baseURL).to.equal('https://explorer.xchain.io');
        expect(new HubConnector({ hubUrl: 'http://hub.test', hubPort: 1 }).urls).to.deep.equal(['http://hub.test']);
    });

    it('agentOptsFor picks the http agent for a bare host named https-hub', function () {
        const httpAgent = { id: 'http' }, httpsAgent = { id: 'https' };
        expect(agentOptsFor('https-hub:10000', { httpAgent, httpsAgent }).httpAgent).to.equal(httpAgent);
        expect(agentOptsFor('https://hub.test', { httpAgent, httpsAgent }).httpsAgent).to.equal(httpsAgent);
    });
});
