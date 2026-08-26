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
 * Unit tests for mcp/server.js: the read-only MCP server. Runs the real
 * MCP protocol over an in-memory transport pair against a stubbed SDK
 * factory: no network, no real XChainSDK instances.
 *
 ********************************************************************/

'use strict';

const fs = require('fs');
const path = require('path');
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
            'compose_action',
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

describe('MCP server (write tools)', () => {

    const POLICY = { allowedActions: ['SEND'], maxPerAction: { SEND: { '*': '10' } } };

    function writableStub(network) {
        const base = stubSdk(network);
        base.createAction = (...a) => { base.calls.push(['createAction', ...a]); return Promise.resolve({ actionString: 'SEND|0|TOK|5|dest' }); };
        base.encodeTx = (...a) => { base.calls.push(['encodeTx', ...a]); return Promise.resolve({ psbt: 'deadbeef', encoding: 'OP_RETURN' }); };
        base.agentSession = (wif, policy) => {
            base.calls.push(['agentSession', wif === undefined ? 'NO-WIF' : 'WIF-SET', policy]);
            return {
                address: 'agentaddr', pubkey: 'agentpub',
                getBalances: async () => [{ tick: 'TOK', amount: '1' }],
                _windowUsage: () => ({ count: 0, perTick: {}, hours: 24 }),
                submit: async (actionData) => {
                    base.calls.push(['session.submit', actionData]);
                    if (actionData.params && actionData.params.amount === '999') {
                        const e = new Error('cap exceeded'); e.code = 'POLICY_AMOUNT_EXCEEDED'; e.name = 'SDKPolicyError';
                        throw e;
                    }
                    return { txid: 'txAA', status: 'valid', policy: { action: actionData.action, windowUsage: { count: 1 } } };
                },
            };
        };
        return base;
    }

    it('without wallet config: write tools absent, compose demands a pubkey', async () => {
        const { client } = await connectedPair();
        const names = (await client.listTools()).tools.map((t) => t.name);
        expect(names).to.include('compose_action');
        expect(names).to.not.include('submit_action');
        expect(names).to.not.include('get_agent_wallet');
        const res = await client.callTool({ name: 'compose_action', arguments: { coin: 'BTC', action: 'SEND', params: { tick: 'TOK', amount: '5' } } });
        expect(res.isError).to.equal(true);
        expect(JSON.parse(res.content[0].text).code).to.equal('MISSING_PUBKEY');
    });

    it('refuses to build with incomplete or human-in-the-loop wallet config', () => {
        expect(() => buildServer({ wallet: { wif: 'W' } })).to.throw(/fail-closed/);
        expect(() => buildServer({ wallet: { wif: 'W', policy: { allowedActions: ['SEND'], confirmAbove: {} } } }))
            .to.throw(/confirmAbove/);
    });

    it('refuses a wallet policy that carries no binding amount ceiling', () => {
        // The confirmAbove rejection above drops the human approval on the grounds
        // that hard caps replace it, so a policy with no amount ceiling must be
        // refused. This also pins the deliberate divergence from policyEvaluator's
        // hasAmountLimit, which additionally counts confirmAbove: copying that third
        // clause into mcp/server.js's hasAmountCap would let a confirmAbove-only
        // policy satisfy the ceiling requirement, and the last case below is what
        // catches that edit - it asserts the refusal a confirmAbove-only policy gets
        // still comes from a rail that has no ceiling notion of confirmAbove at all.
        const build = (policy) => () => buildServer({
            sdkFactory: (network) => writableStub(network),
            fetch: async () => ({ ok: true, text: async () => 'x' }),
            wallet: { wif: 'W', policy },
        });
        expect(build({ allowedActions: ['SEND'] })).to.throw(/binding amount ceiling/);
        // A count cap bounds how MANY actions, not how much value.
        expect(build({ allowedActions: ['SEND'], maxPerWindow: { maxActions: 5 } }))
            .to.throw(/binding amount ceiling/);
        // Both real ceilings are accepted, so the gate is not simply refusing everything.
        expect(build({ allowedActions: ['SEND'], maxPerWindow: { perTick: { TOK: '10' } } })).to.not.throw();
        expect(build(POLICY)).to.not.throw();
    });

    it('keeps confirmAbove out of the ceiling predicate, which no runtime test can pin', () => {
        // hasAmountCap is policyEvaluator's hasAmountLimit minus its
        // `|| !!policy.confirmAbove` clause, and the omission is deliberate: on this
        // rail confirmAbove is rejected upstream, so it can never be a real ceiling.
        // The reason this assertion reads the SOURCE rather than driving buildServer
        // is that the upstream rejection makes the clause unreachable - adding it back
        // changes no observable behaviour, and every runtime test in this file still
        // passes with it present (verified by mutation). It only becomes an unbounded
        // -spend hole once someone ALSO relaxes the upstream rejection, and by then
        // the widened predicate is already in the tree waiting. So the invariant is a
        // source-level one, and this is what makes it enforced rather than merely
        // requested by the comment above it.
        const src = fs.readFileSync(path.join(__dirname, '../../mcp/server.js'), 'utf8');
        const decl = /const hasAmountCap =([\s\S]*?);/.exec(src);
        expect(decl, 'hasAmountCap declaration not found in mcp/server.js').to.not.equal(null);
        expect(decl[1]).to.match(/maxPerAction/);
        expect(decl[1]).to.match(/perTick/);
        expect(decl[1], 'confirmAbove must never count as a binding ceiling on the MCP rail')
            .to.not.match(/confirmAbove/);
    });

    it('with wallet config: submit_action flows through AgentSession and reports policy usage', async () => {
        const created = [];
        const server = buildServer({
            sdkFactory: (network) => { const s = writableStub(network); created.push(s); return s; },
            fetch: async () => ({ ok: true, text: async () => 'x' }),
            wallet: { wif: 'WIF', policy: POLICY },
        });
        const client = new Client({ name: 't', version: '0' });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        await Promise.all([server.connect(st), client.connect(ct)]);

        const names = (await client.listTools()).tools.map((t) => t.name);
        expect(names).to.include.members(['submit_action', 'get_agent_wallet', 'compose_action']);

        const res = await client.callTool({
            name: 'submit_action',
            arguments: { coin: 'TDOGE', action: 'send', params: { tick: 'TOK', amount: '5', destination: 'd1' } },
        });
        const body = JSON.parse(res.content[0].text);
        expect(body.txid).to.equal('txAA');
        expect(body.policy.windowUsage.count).to.equal(1);
        const sessCall = created[0].calls.find((c) => c[0] === 'agentSession');
        expect(sessCall[2]).to.deep.equal(POLICY);
        const submitCall = created[0].calls.find((c) => c[0] === 'session.submit');
        expect(submitCall[1].action).to.equal('SEND');             // uppercased

        const denied = await client.callTool({
            name: 'submit_action',
            arguments: { coin: 'TDOGE', action: 'SEND', params: { tick: 'TOK', amount: '999' } },
        });
        expect(denied.isError).to.equal(true);
        expect(JSON.parse(denied.content[0].text).code).to.equal('POLICY_AMOUNT_EXCEEDED');
    });

    it('compose_action composes unsigned PSBTs via the agent wallet address and never submits', async () => {
        const created = [];
        const server = buildServer({
            sdkFactory: (network) => { const s = writableStub(network); created.push(s); return s; },
            fetch: async () => ({ ok: true, text: async () => 'x' }),
            wallet: { wif: 'WIF', policy: POLICY },
        });
        const client = new Client({ name: 't', version: '0' });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        await Promise.all([server.connect(st), client.connect(ct)]);

        const res = await client.callTool({ name: 'compose_action', arguments: { coin: 'BTC', action: 'send', params: { tick: 'TOK', amount: '5' } } });
        const body = JSON.parse(res.content[0].text);
        expect(body).to.deep.equal({ action_string: 'SEND|0|TOK|5|dest', psbt: 'deadbeef', encoding: 'OP_RETURN', signed: false });
        // The default sender is the session ADDRESS (the encoder's pubkey field
        // base58-decodes on the P2SH path; a hex pubkey breaks past OP_RETURN).
        expect(created[0].calls.find((c) => c[0] === 'encodeTx')[1]).to.deep.equal({ pubkey: 'agentaddr', data: 'SEND|0|TOK|5|dest' });
        expect(created[0].calls.some((c) => c[0] === 'session.submit')).to.equal(false);
    });
});
