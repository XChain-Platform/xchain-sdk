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
const { buildServer, COIN_NETWORKS } = require('../../../../mcp/server.js');

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

const POLICY = { allowedActions: ['SEND'], maxPerAction: { SEND: { '*': '10' } } };

function writableStub(network) {
    const base = stubSdk(network);
    base.createAction = (...a) => { base.calls.push(['createAction', ...a]); return Promise.resolve({ actionString: 'SEND|0|TOK|5|dest' }); };
    base.encodeTx = (...a) => { base.calls.push(['encodeTx', ...a]); return Promise.resolve({ psbt: 'deadbeef', encoding: 'OP_RETURN' }); };
    base.agentSession = (wif, policy) => {
        base.calls.push(['agentSession', wif === undefined ? 'NO-WIF' : 'WIF-SET', policy]);
        // Idempotency keys already recorded, so the stub refuses a repeat the
        // way the real AgentSession does.
        const seen = new Map();
        return {
            address: 'agentaddr', pubkey: 'agentpub',
            getBalances: async () => [{ tick: 'TOK', amount: '1' }],
            _windowUsage: () => ({ count: 0, perTick: {}, hours: 24 }),
            // Mirrors AgentSession.submit(actionData, encoderOpts, submitOpts),
            // INCLUDING its idempotency-key requirement: a stub that ignores the
            // trailing arguments greens a submit_action the real default policy
            // refuses with POLICY_IDEMPOTENCY_REQUIRED.
            submit: async (actionData, encoderOpts, submitOpts) => {
                base.calls.push(['session.submit', actionData, encoderOpts, submitOpts]);
                const key = submitOpts && submitOpts.idempotencyKey;
                if ((key === undefined || key === null) && policy.allowUnkeyedSubmits !== true) {
                    const e = new Error('a spend-capable submit needs a stable submitOpts.idempotencyKey');
                    e.code = 'POLICY_IDEMPOTENCY_REQUIRED'; e.name = 'SDKPolicyError';
                    throw e;
                }
                if (key !== undefined && key !== null && seen.has(String(key))) {
                    const prior = seen.get(String(key));
                    const e = new Error(`a submission with idempotencyKey ${key} was already recorded (txid ${prior})`);
                    e.code = 'POLICY_DUPLICATE_SUBMIT'; e.name = 'SDKPolicyError';
                    e.details = { idempotencyKey: String(key), txid: prior };
                    throw e;
                }
                if (actionData.params && actionData.params.amount === '999') {
                    const e = new Error('cap exceeded'); e.code = 'POLICY_AMOUNT_EXCEEDED'; e.name = 'SDKPolicyError';
                    throw e;
                }
                if (key !== undefined && key !== null) seen.set(String(key), 'txAA');
                return { txid: 'txAA', status: 'valid', policy: { action: actionData.action, windowUsage: { count: 1 } } };
            },
        };
    };
    return base;
}

describe('MCP server (write tools)', () => {

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
});

describe('MCP server (write tools)', () => {

    it('refuses a cap table that is present but holds no usable cap', () => {
        // `{}` is truthy, so a ceiling gate written as `!!pol.maxPerAction` accepted
        // every table below while capFor resolved undefined for each lookup and every
        // amount comparison in policyEvaluator was skipped: submit_action could SEND
        // any amount under a policy the operator wrote as capped.
        const build = (policy) => () => buildServer({
            sdkFactory: (network) => writableStub(network),
            fetch: async () => ({ ok: true, text: async () => 'x' }),
            wallet: { wif: 'W', policy },
        });
        expect(build({ allowedActions: ['SEND'], maxPerAction: {} })).to.throw(/binding amount ceiling/);
        expect(build({ allowedActions: ['SEND'], maxPerAction: { SEND: {} } })).to.throw(/binding amount ceiling/);
        expect(build({ allowedActions: ['SEND'], maxPerAction: { SEND: { TOK: '' } } })).to.throw(/binding amount ceiling/);
        expect(build({ allowedActions: ['SEND'], maxPerWindow: { hours: 24, perTick: {} } })).to.throw(/binding amount ceiling/);
        // An INHERITED entry must not make an empty table look populated: capFor
        // reads own properties only, so it would resolve no cap from one (G1).
        expect(build({ allowedActions: ['SEND'], maxPerAction: { SEND: Object.create({ TOK: '5' }) } }))
            .to.throw(/binding amount ceiling/);
        // A populated table on either clause still builds.
        expect(build({ allowedActions: ['SEND'], maxPerAction: { SEND: { TOK: '5' } } })).to.not.throw();
        expect(build({ allowedActions: ['SEND'], maxPerWindow: { hours: 24, perTick: { '*': '5' } } })).to.not.throw();
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
        const src = fs.readFileSync(path.join(__dirname, '../../../../mcp/server.js'), 'utf8');
        const decl = /const hasAmountCap =([\s\S]*?);/.exec(src);
        expect(decl, 'hasAmountCap declaration not found in mcp/server.js').to.not.equal(null);
        expect(decl[1]).to.match(/maxPerAction/);
        expect(decl[1]).to.match(/perTick/);
        expect(decl[1], 'confirmAbove must never count as a binding ceiling on the MCP rail')
            .to.not.match(/confirmAbove/);
    });
});

describe('MCP server (write tools)', () => {

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
});

describe('MCP server (write tools)', () => {

    // AgentSession requires submitOpts.idempotencyKey unless the operator sets
    // allowUnkeyedSubmits, and submit_action passed no submit options at all, so
    // under the default policy the tool refused every call it was otherwise
    // allowed to make. The old one-argument stub could not see that.
    it('submit_action supplies the idempotency key AgentSession requires', async () => {
        const created = [];
        const server = buildServer({
            sdkFactory: (network) => { const s = writableStub(network); created.push(s); return s; },
            fetch: async () => ({ ok: true, text: async () => 'x' }),
            wallet: { wif: 'WIF', policy: POLICY },
        });
        const client = new Client({ name: 't', version: '0' });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        await Promise.all([server.connect(st), client.connect(ct)]);

        const res = await client.callTool({
            name: 'submit_action',
            arguments: { coin: 'TDOGE', action: 'send', params: { tick: 'TOK', amount: '5', destination: 'd1' } },
        });
        expect(res.isError, JSON.stringify(res.content)).to.not.equal(true);
        const submitCall = created[0].calls.find((c) => c[0] === 'session.submit');
        expect(submitCall[3], 'submit must receive submitOpts as its third argument').to.be.an('object');
        expect(submitCall[3].idempotencyKey).to.be.a('string').and.have.length.greaterThan(0);
    });
});

describe('MCP server (write tools)', () => {

    it('derives the same key for the same submission and a different one for a different submission', async () => {
        const created = [];
        const server = buildServer({
            sdkFactory: (network) => { const s = writableStub(network); created.push(s); return s; },
            fetch: async () => ({ ok: true, text: async () => 'x' }),
            wallet: { wif: 'WIF', policy: POLICY },
        });
        const client = new Client({ name: 't', version: '0' });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        await Promise.all([server.connect(st), client.connect(ct)]);

        const call = (params) => client.callTool({
            name: 'submit_action', arguments: { coin: 'TDOGE', action: 'SEND', params },
        });

        const first = await call({ tick: 'TOK', amount: '5', destination: 'd1' });
        expect(first.isError).to.not.equal(true);

        // The model re-emits the same request with its keys in another order. That
        // is the same payment, so it must hash the same and be refused with the
        // txid of the payment that already went out.
        const repeat = await call({ destination: 'd1', amount: '5', tick: 'TOK' });
        expect(repeat.isError).to.equal(true);
        const body = JSON.parse(repeat.content[0].text);
        expect(body.code).to.equal('POLICY_DUPLICATE_SUBMIT');
        expect(body.txid, 'the caller needs the prior txid to resume instead of retrying').to.equal('txAA');

        // A different payment is a different key and goes through.
        const other = await call({ tick: 'TOK', amount: '6', destination: 'd1' });
        expect(other.isError, JSON.stringify(other.content)).to.not.equal(true);

        const keys = created[0].calls.filter((c) => c[0] === 'session.submit').map((c) => c[3].idempotencyKey);
        expect(keys[0]).to.equal(keys[1]);
        expect(keys[2]).to.not.equal(keys[0]);
    });
});

describe('MCP server (write tools)', () => {

    it('a caller-supplied idempotency_key overrides the derived one, so a deliberate repeat is possible', async () => {
        const created = [];
        const server = buildServer({
            sdkFactory: (network) => { const s = writableStub(network); created.push(s); return s; },
            fetch: async () => ({ ok: true, text: async () => 'x' }),
            wallet: { wif: 'WIF', policy: POLICY },
        });
        const client = new Client({ name: 't', version: '0' });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        await Promise.all([server.connect(st), client.connect(ct)]);

        const params = { tick: 'TOK', amount: '5', destination: 'd1' };
        const first = await client.callTool({ name: 'submit_action', arguments: { coin: 'TDOGE', action: 'SEND', params } });
        expect(first.isError).to.not.equal(true);

        const again = await client.callTool({
            name: 'submit_action',
            arguments: { coin: 'TDOGE', action: 'SEND', params, idempotency_key: 'payroll-run-2' },
        });
        expect(again.isError, JSON.stringify(again.content)).to.not.equal(true);

        const keys = created[0].calls.filter((c) => c[0] === 'session.submit').map((c) => c[3].idempotencyKey);
        expect(keys[1]).to.equal('payroll-run-2');
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
