// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const sinon = require('sinon');
const { expect } = require('chai');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { buildServer } = require('../../../../mcp/server.js');
const AgentSession = require('../../../../src/cosigner/agent_session.js');
const WalletSession = require('../../../../src/utils/wallet_session.js');

const POLICY = { allowedActions: ['SEND'], maxPerAction: { SEND: { '*': '10' } } };
const KEY = {
    publicKeyHex: '02ab', publicKey: Buffer.from('02ab', 'hex'), compressed: true,
};

async function connected() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-submit-retry-'));
    const sdkFactory = (network) => {
        const sdk = {
            network,
            wallet: { importWIF: () => KEY, deriveAddress: () => 'agentaddr' },
        };
        sdk.agentSession = (wif, policy) => new AgentSession(sdk, wif,
            Object.assign({}, policy, { stateFile: path.join(dir, 'usage.json') }));
        return sdk;
    };
    const server = buildServer({ sdkFactory, wallet: { wif: 'WIF', policy: POLICY } });
    const client = new Client({ name: 'submit-retry', version: '0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
}

const submit = (client) => client.callTool({
    name: 'submit_action',
    arguments: { coin: 'TDOGE', action: 'SEND', params: { tick: 'TOK', amount: '5' } },
});

const submitParams = (client, params) => client.callTool({
    name: 'submit_action',
    arguments: { coin: 'TDOGE', action: 'SEND', params },
});

describe('MCP submit_action retry contract', () => {
    afterEach(() => sinon.restore());

    it('allows the identical call after a proven pre-broadcast failure', async () => {
        const failure = Object.assign(new Error('create failed'), { preBroadcast: true });
        const body = sinon.stub(WalletSession.prototype, 'submitInner');
        body.onFirstCall().rejects(failure);
        body.onSecondCall().resolves({
            txid: 'retry-tx',
            indexed: { status: 'valid', statusKnown: true, statusSource: 'indexer' },
        });
        const client = await connected();

        expect((await submit(client)).isError).to.equal(true);
        const retry = await submit(client);
        expect(retry.isError, JSON.stringify(retry.content)).to.not.equal(true);
        expect(JSON.parse(retry.content[0].text)).to.include({
            txid: 'retry-tx', status: 'valid', statusKnown: true, statusSource: 'indexer',
        });
        expect(body.calledTwice).to.equal(true);
    });

    it('reports an unknown outcome when an ambiguous attempt has no txid', async () => {
        const body = sinon.stub(WalletSession.prototype, 'submitInner')
            .rejects(new Error('broadcast acknowledgement lost'));
        const client = await connected();

        expect((await submit(client)).isError).to.equal(true);
        const retry = await submit(client);
        const response = JSON.parse(retry.content[0].text);
        expect(response).to.include({ code: 'POLICY_DUPLICATE_SUBMIT', txid: null, outcome: 'unknown' });
        expect(response.error).to.match(/outcome is unknown/i);
        expect(body.calledOnce).to.equal(true);
    });

    it('describes both safe pre-broadcast retries and ambiguous duplicate refusals', async () => {
        sinon.stub(WalletSession.prototype, 'submitInner').resolves({
            txid: 'tx', indexed: { status: 'valid', statusKnown: true, statusSource: 'indexer' },
        });
        const client = await connected();
        const description = (await client.listTools()).tools
            .find((tool) => tool.name === 'submit_action').description;
        expect(description).to.match(/failed before broadcasting can be repeated/i);
        expect(description).to.match(/without a txid.*outcome is unknown/i);
    });

    it('surfaces assumed and absent indexer verdicts without inventing confirmation', async () => {
        const body = sinon.stub(WalletSession.prototype, 'submitInner');
        body.onFirstCall().resolves({
            txid: 'assumed-tx',
            indexed: { status: 'valid', statusKnown: false, statusSource: 'assumed' },
        });
        body.onSecondCall().resolves({ txid: 'no-verdict-tx', indexed: null });
        const client = await connected();

        const assumed = JSON.parse((await submitParams(client, { tick: 'TOK', amount: '4' })).content[0].text);
        expect(assumed).to.include({
            txid: 'assumed-tx', status: 'valid', statusKnown: false, statusSource: 'assumed',
        });
        const absent = JSON.parse((await submitParams(client, { tick: 'TOK', amount: '3' })).content[0].text);
        expect(absent).to.include({ txid: 'no-verdict-tx', status: null, statusKnown: false, statusSource: null });
    });

    it('blocks respelled, colliding, and multi-leg cap bypasses before broadcast', async () => {
        const body = sinon.stub(WalletSession.prototype, 'submitInner').resolves({ txid: 'unexpected' });
        const client = await connected();
        const cases = [
            [{ Tick: 'TOK', Amount: '99' }, 'POLICY_AMOUNT_EXCEEDED'],
            [{ tick: 'TOK', amount: '1', AMOUNT: '99' }, 'POLICY_PARAM_KEY_COLLISION'],
            [{ tick: 'TOK', legs: [{ amount: '99', destination: 'other' }] }, 'POLICY_LEGS_UNSUPPORTED'],
        ];

        for (const [params, code] of cases) {
            const response = await submitParams(client, params);
            expect(response.isError).to.equal(true);
            expect(JSON.parse(response.content[0].text).code).to.equal(code);
        }
        expect(body.called).to.equal(false);
    });
});
