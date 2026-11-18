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
 * Tool-surface contract for mcp/server.js: what the write-adjacent tools
 * declare, what the wallet gate lets through, that the build refuses a
 * policy AgentSession would refuse on every call, and that reads reach the
 * SDK through its own client.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const nock = require('nock');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { buildServer } = require('../../../../mcp/server.js');
const AgentSession = require('../../../../src/cosigner/agent_session.js');
const XChainSDK = require('../../../../src/XChainSDK.js');

const TICKET = { id: 'a'.repeat(32), expiresAt: 1 };

function surfaceStub(network) {
    const calls = [];
    return {
        network, calls,
        createAction: async () => ({ actionString: 'SEND|0|TOK|5|dest' }),
        encodeTx: async (params) => { calls.push(['encodeTx', params]); return { psbt: 'beef', encoding: 'OP_RETURN', reservation: TICKET }; },
        verifyCheckpoint: async (height) => { calls.push(['verifyCheckpoint', height]); return { verified: true }; },
        requireEncoder: () => ({
            releaseInputs: async (id) => { calls.push(['releaseInputs', id]); return { reservationId: id, found: true, released: ['x:0'], retained: [] }; },
        }),
        agentSession: () => ({ address: 'agentaddr' }),
    };
}

async function connect(options) {
    const created = [];
    const server = buildServer(Object.assign({
        sdkFactory: (network) => { const s = surfaceStub(network); created.push(s); return s; },
    }, options || {}));
    const client = new Client({ name: 'surface', version: '0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    return { client, created };
}

const realSdk = (network) => new XChainSDK({ network, explorerUrl: 'explorer.test', explorerPort: 8080, retry: false });

const build = (policy) => () => buildServer({
    sdkFactory: surfaceStub,
    wallet: { wif: 'W', policy },
});

describe('MCP server (tool surface contract)', () => {

    it('compose_action hands back the reservation ticket and release_reservation redeems it', async () => {
        const { client, created } = await connect();
        const composed = await client.callTool({
            name: 'compose_action',
            arguments: { coin: 'RBTC', action: 'send', params: { tick: 'TOK', amount: '5' }, pubkey: 'senderaddr' },
        });
        const body = JSON.parse(composed.content[0].text);
        expect(body.reservation).to.deep.equal(TICKET);

        const released = await client.callTool({
            name: 'release_reservation', arguments: { coin: 'RBTC', reservation_id: body.reservation.id },
        });
        expect(released.isError, JSON.stringify(released.content)).to.not.equal(true);
        expect(JSON.parse(released.content[0].text).found).to.equal(true);
        expect(created[0].calls.filter((c) => c[0] === 'releaseInputs')).to.deep.equal([['releaseInputs', TICKET.id]]);
    });

    it('release_reservation refuses an id that is not a 32-character lowercase hex ticket', async () => {
        const { client, created } = await connect();
        for (const reservation_id of ['', 'xyz', 'A'.repeat(32), 'a'.repeat(31), 'a'.repeat(33)]) {
            const res = await client.callTool({ name: 'release_reservation', arguments: { coin: 'RBTC', reservation_id } });
            expect(res.isError, JSON.stringify(reservation_id)).to.equal(true);
        }
        expect(created).to.have.lengthOf(0);
    });
});

describe('MCP server (tool surface contract)', () => {

    it('marks the two tools that touch encoder reservations as writes, not read-only', async () => {
        const { client } = await connect();
        const { tools } = await client.listTools();
        for (const name of ['compose_action', 'release_reservation']) {
            const t = tools.find((x) => x.name === name);
            expect(t.annotations.readOnlyHint, `${name} readOnlyHint`).to.equal(false);
            expect(t.annotations.destructiveHint, `${name} destructiveHint`).to.equal(false);
        }
        expect(tools.find((x) => x.name === 'release_reservation').annotations.idempotentHint).to.equal(true);
        expect(tools.find((x) => x.name === 'compose_action').description).to.match(/RESERVES the sender's selected UTXOs/);
    });
});

describe('MCP server (tool surface contract)', () => {

    it('refuses a cap that binds none of the allowed actions', () => {
        // The evaluator reads maxPerAction by the exact upper-case action name, so a
        // lower-case key and a cap on an action that is not allowed both leave SEND
        // unbounded while a "some cap exists" test passes.
        const lower = build({ allowedActions: ['SEND'], maxPerAction: { send: { '*': '10' } } });
        expect(lower).to.throw(/SEND without a binding amount ceiling/);
        const other = build({ allowedActions: ['SEND'], maxPerAction: { MINT: { '*': '10' } } });
        expect(other).to.throw(/SEND without a binding amount ceiling/);
        const mixed = build({ allowedActions: ['SEND', 'MINT'], maxPerAction: { MINT: { '*': '10' } } });
        expect(mixed).to.throw(/SEND without a binding amount ceiling/);
        // An inherited key is not an own cap entry.
        const inherited = build({ allowedActions: ['SEND'], maxPerAction: Object.create({ SEND: { '*': '10' } }) });
        expect(inherited).to.throw(/binding amount ceiling/);
    });

    it('accepts a cap table that reaches every allowed action', () => {
        const cap = { '*': '10' };
        expect(build({ allowedActions: ['send'], maxPerAction: { SEND: cap } })).to.not.throw();
        expect(build({ allowedActions: ['SEND', 'mint'], maxPerAction: { SEND: cap, MINT: cap } })).to.not.throw();
        // A usable perTick entry applies to every amount-bearing action.
        expect(build({
            allowedActions: ['SEND', 'MINT'], maxPerWindow: { hours: 24, perTick: { '*': '10' } },
        })).to.not.throw();
    });
});

describe('MCP server (tool surface contract)', () => {

    it('refuses at build time the policies AgentSession would refuse on every call', () => {
        const cap = { SEND: { '*': '10' } };
        const refused = [
            { allowedActions: ['SEND'], maxPerWindow: { perTick: { TOK: '10' } } },
            { allowedActions: ['SEND'], maxPerWindow: { hours: 0, perTick: { TOK: '10' } } },
            { maxPerAction: cap },
            { allowedActions: [], maxPerAction: cap },
            { allowedActions: ['SEND'], maxPerAction: cap, idempotencyHours: 0 },
        ];
        for (const policy of refused) {
            let thrown = null;
            try { build(policy)(); } catch (err) { thrown = err; }
            expect(thrown, JSON.stringify(policy)).to.not.equal(null);
            expect(thrown.code, JSON.stringify(policy)).to.equal('POLICY_INVALID');
        }
        expect(build({ allowedActions: ['SEND'], maxPerAction: cap, idempotencyHours: 48 })).to.not.throw();
    });

    it('validates with the SDK export, so the two checks cannot drift apart', () => {
        expect(AgentSession.validatePolicy).to.be.a('function');
        const policy = { allowedActions: ['SEND'], maxPerWindow: { perTick: { TOK: '10' } } };
        expect(() => AgentSession.validatePolicy(policy)).to.throw(/hours/);
        expect(build(policy)).to.throw(/hours/);
    });
});

describe('MCP server (tool surface contract)', () => {
    afterEach(() => nock.cleanAll());

    it('verify_checkpoint never reads sdk.explorer, so its target does not depend on call order', async () => {
        let reads = 0;
        const { client } = await connect({
            sdkFactory: (network) => Object.defineProperty(surfaceStub(network), 'explorer', {
                get() { reads += 1; return { baseUrl: 'https://pre-discovery.example', port: 8080 }; },
            }),
        });
        await client.callTool({ name: 'verify_checkpoint', arguments: { coin: 'RBTC', block_index: 7 } });
        expect(reads).to.equal(0);
    });

    it('verify_checkpoint reaches the explorer through the real SDK client and coin route', async () => {
        const scope = nock('http://explorer.test:8080').get('/RBTC/api/checkpoint/5/verify').reply(200, { not: 'a checkpoint' });
        const { client } = await connect({ sdkFactory: realSdk });
        const res = await client.callTool({ name: 'verify_checkpoint', arguments: { coin: 'RBTC', block_index: 5 } });
        expect(scope.isDone(), 'the checkpoint route was requested').to.equal(true);
        expect(res.isError).to.equal(true);
        expect(JSON.parse(res.content[0].text).error).to.match(/no checkpoint in response/);
    });

    it('get_executions asks for contract action index 0 by its own route, not the global list', async () => {
        const scope = nock('http://explorer.test:8080').get('/RBTC/api/executions/0/contract').query(true)
            .reply(200, { total: 0, data: [] });
        const { client } = await connect({ sdkFactory: realSdk });
        const res = await client.callTool({ name: 'get_executions', arguments: { coin: 'RBTC', contract_action_index: 0 } });
        expect(res.isError, JSON.stringify(res.content)).to.not.equal(true);
        expect(scope.isDone(), 'the filtered route was requested').to.equal(true);
    });
});
