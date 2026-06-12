/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * Unit tests for mcp/server.js — the read-only MCP server. Runs the real
 * MCP protocol over an in-memory transport pair against a stubbed SDK
 * factory: no network, no real XChainSDK instances.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { buildServer, COIN_NETWORKS } = require('../../mcp/server.js');

// Minimal XChainSDK stand-in: records calls, returns canned values.
function stubSdk(network) {
    const calls = [];
    const record = (name) => (...args) => { calls.push([name, ...args]); return Promise.resolve({ ok: name, network }); };
    return {
        network, calls,
        explorer: { baseUrl: 'https://explorer.example', port: 8080 },
        checkpoint: { fetchAndVerifyCheckpoint: (...a) => { calls.push(['fetchAndVerifyCheckpoint', ...a]); return Promise.resolve({ verified: true }); } },
        getStatus: record('getStatus'),
        getFeeSchedule: record('getFeeSchedule'),
        getToken: record('getToken'),
        getTokens: record('getTokens'),
        getHolders: record('getHolders'),
        getProject: record('getProject'),
        getBalances: record('getBalances'),
        getAddress: record('getAddress'),
        getHistory: record('getHistory'),
        getAction: record('getAction'),
        getBlock: record('getBlock'),
        search: record('search'),
        getDispensers: record('getDispensers'),
        getMarkets: record('getMarkets'),
        getMarket: record('getMarket'),
        getOrderbook: record('getOrderbook'),
        getContract: record('getContract'),
        getContractState: record('getContractState'),
        getExecutions: record('getExecutions'),
        getAttestations: record('getAttestations'),
        getValidators: record('getValidators'),
    };
}

async function connectedPair(options) {
    const created = [];
    const server = buildServer(Object.assign({
        sdkFactory: (network) => { const s = stubSdk(network); created.push(s); return s; },
        fetch: async () => ({ ok: true, text: async () => 'docs-body' }),
    }, options || {}));
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    return { server, client, created };
}

describe('MCP server (read-only)', () => {

    it('lists the expected tools, all marked read-only', async () => {
        const { client } = await connectedPair();
        const { tools } = await client.listTools();
        const names = tools.map((t) => t.name).sort();
        expect(names).to.deep.equal([
            'get_action', 'get_address', 'get_attestations', 'get_balances', 'get_block',
            'get_contract', 'get_contract_state', 'get_dispensers', 'get_executions',
            'get_fee_schedule', 'get_history', 'get_holders', 'get_market', 'get_markets',
            'get_orderbook', 'get_project', 'get_status', 'get_token', 'get_validators',
            'search', 'search_tokens', 'verify_checkpoint',
        ]);
        for (const t of tools) {
            expect(t.annotations && t.annotations.readOnlyHint, `${t.name} readOnlyHint`).to.equal(true);
            expect(t.description, `${t.name} description`).to.be.a('string').and.not.empty;
        }
    });

    it('creates SDK instances lazily, one per coin, with the right network', async () => {
        const { client, created } = await connectedPair();
        expect(created).to.have.lengthOf(0);                       // listing tools opens nothing
        await client.callTool({ name: 'get_status', arguments: { coin: 'TDOGE' } });
        await client.callTool({ name: 'get_token', arguments: { coin: 'TDOGE', tick: 'XCHAIN' } });
        await client.callTool({ name: 'get_status', arguments: { coin: 'BTC' } });
        expect(created).to.have.lengthOf(2);
        expect(created[0].network).to.equal('dogecoin-testnet');
        expect(created[1].network).to.equal('bitcoin-mainnet');
    });

    it('routes tool args through to the SDK methods', async () => {
        const { client, created } = await connectedPair();
        const res = await client.callTool({
            name: 'get_history',
            arguments: { coin: 'BTC', query: 'bc1qabc', type: 'address', page: 2, limit: 5 },
        });
        expect(created[0].calls[0]).to.deep.equal(['getHistory', 'bc1qabc', 'address', { page: 2, limit: 5 }]);
        const body = JSON.parse(res.content[0].text);
        expect(body).to.deep.equal({ ok: 'getHistory', network: 'bitcoin-mainnet' });
    });

    it('verify_checkpoint builds the explorer base URL and passes coin + height', async () => {
        const { client, created } = await connectedPair();
        await client.callTool({ name: 'verify_checkpoint', arguments: { coin: 'TBTC', block_index: 1234 } });
        const call = created[0].calls[0];
        expect(call[0]).to.equal('fetchAndVerifyCheckpoint');
        expect(call[1]).to.equal('https://explorer.example');
        expect(call[2]).to.equal('TBTC');
        expect(call[3]).to.equal(1234);
    });

    it('rejects an unknown coin at the schema layer', async () => {
        const { client, created } = await connectedPair();
        const res = await client.callTool({ name: 'get_status', arguments: { coin: 'XYZ' } });
        expect(res.isError).to.equal(true);
        expect(res.content[0].text).to.match(/invalid|enum|XYZ/i);
        expect(created).to.have.lengthOf(0);                       // never reached an SDK
    });

    it('SDK errors come back as isError tool results with the code preserved', async () => {
        const boom = Object.assign(new Error('explorer unreachable'), { code: 'SDKExplorerError' });
        const { client } = await connectedPair({
            sdkFactory: () => ({ getStatus: () => Promise.reject(boom) }),
        });
        const res = await client.callTool({ name: 'get_status', arguments: { coin: 'BTC' } });
        expect(res.isError).to.equal(true);
        const body = JSON.parse(res.content[0].text);
        expect(body).to.deep.equal({ error: 'explorer unreachable', code: 'SDKExplorerError' });
    });

    it('serves the docs resources via fetch', async () => {
        const { client } = await connectedPair();
        const { resources } = await client.listResources();
        const uris = resources.map((r) => r.uri).sort();
        expect(uris).to.deep.equal(['xchain://docs/llms-full.txt', 'xchain://docs/llms.txt']);
        const read = await client.readResource({ uri: 'xchain://docs/llms.txt' });
        expect(read.contents[0].text).to.equal('docs-body');
    });

    it('covers all nine coin prefixes', () => {
        expect(Object.keys(COIN_NETWORKS)).to.have.lengthOf(9);
        for (const net of Object.values(COIN_NETWORKS))
            expect(net).to.match(/^(bitcoin|litecoin|dogecoin)-(mainnet|testnet|regtest)$/);
    });
});
