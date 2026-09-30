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
const XChainSDK = require('../../../src/XChainSDK.js');
const LightClient = require('../../../src/protocol/light_client.js');

// Endpoint env vars the SDK consults: cleared so tests are deterministic.
const ENV_KEYS = ['NETWORK', 'EXPLORER_URL', 'EXPLORER_PORT', 'ENCODER_URL',
    'ENCODER_PORT', 'HUB_API_HOST', 'HUB_PORT', 'WEBSOCKET_URL', 'WEBSOCKET_PORT'];

// Drive the three network-sensitive sdk.light methods with no coin fields and
// record every URL they fetch, so a test can see which namespace each one used.
async function collectLightUrls(tier) {
    const sdk = new XChainSDK({ network: 'litecoin-' + tier, explorerUrl: 'https://x' });
    const urls = [];
    const fetchImpl = async (url) => {
        urls.push(url);
        if (url.includes('/api/anchors/'))
            return { ok: true, status: 200, json: async () => [] };
        if (url.includes('/api/checkpoints/range'))
            return { ok: true, status: 200, json: async () => ({ checkpoints: [] }) };
        return { ok: true, status: 200, json: async () => ({}) };
    };
    await sdk.light.fetchAnchoredCheckpoint({ explorerUrl: 'https://x', targetChain: 'LTC', fetchImpl });
    try {
        await sdk.light.verifyValidatorSet({
            explorerUrl: 'https://x', snapshotBlock: 7, trustedStateRoot: 'aa'.repeat(32), fetchImpl
        });
    } catch (e) {
        expect(e.message).to.equal('LightClient: no validator-set proof in response');
    }
    await sdk.light.followForward({
        explorerUrl: 'https://x',
        trustedCheckpoint: { network: tier, block_index: 1, state_root: 'aa'.repeat(32) },
        toHeight: 2,
        fetchImpl
    });
    return urls;
}

// The stateless helpers called with a non-mainnet context and no coin field.
function statelessCallsWithoutCoin(fetchImpl) {
    return [
        () => LightClient.fetchAnchoredCheckpoint({
            explorerUrl: 'https://x', network: 'testnet', targetChain: 'BTC', fetchImpl
        }),
        () => LightClient.verifyValidatorSet({
            explorerUrl: 'https://x', network: 'testnet', snapshotBlock: 7, fetchImpl
        }),
        () => LightClient.followForward({
            explorerUrl: 'https://x',
            trustedCheckpoint: { network: 'regtest', block_index: 1, state_root: 'aa'.repeat(32) },
            toHeight: 2,
            fetchImpl
        })
    ];
}

describe('XChainSDK light-client network resolution', function () {
    let saved;
    beforeEach(function () {
        saved = {};
        for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    });
    afterEach(function () {
        for (const k of ENV_KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    });

    const cases = {
        mainnet: { doge: 'DOGE', btc: 'BTC' },
        testnet: { doge: 'TDOGE', btc: 'TBTC' },
        regtest: { doge: 'RDOGE', btc: 'RBTC' }
    };

    for (const [tier, coins] of Object.entries(cases)) {
        it(tier + ' instances bind omitted DOGE and BTC helpers to their network', async function () {
            expect(await collectLightUrls(tier)).to.deep.equal([
                'https://x/' + coins.doge + '/api/anchors/LTC/chain',
                'https://x/' + coins.btc + '/api/proof/validator-set?height=7',
                'https://x/' + coins.btc + '/api/checkpoints/range?from=2&to=2'
            ]);
        });
    }

    it('stateless helpers refuse an omitted coin when non-mainnet context is explicit', async function () {
        let fetchCount = 0;
        const fetchImpl = async () => {
            fetchCount++;
            return { ok: true, status: 200, json: async () => [] };
        };
        const messages = [];
        for (const call of statelessCallsWithoutCoin(fetchImpl)) {
            try { await call(); } catch (e) { messages.push(e.message); }
        }
        expect(messages).to.deep.equal([
            'LightClient: dogeCoin is required for testnet network context',
            'LightClient: btcCoin is required for testnet network context',
            'LightClient: btcCoin is required for regtest network context'
        ]);
        expect(fetchCount).to.equal(0);
    });
});
