// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-param-keys-'));
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
    const client = new Client({ name: 'param-key-canonicalization', version: '0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
}

const submitParams = (client, params) => client.callTool({
    name: 'submit_action',
    arguments: { coin: 'TDOGE', action: 'SEND', params },
});

describe('MCP submit_action retry contract', () => {
    afterEach(() => sinon.restore());

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
