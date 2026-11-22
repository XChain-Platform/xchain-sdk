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

const { expect } = require('chai');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { buildServer } = require('../../../../mcp/server.js');

const POLICY = { allowedActions: ['SEND'], maxPerAction: { SEND: { '*': '10' } } };

async function connected() {
    const sdkFactory = (network) => ({
        network,
        agentSession: () => ({
            address: 'agentaddr',
            pubkey: 'agentpub',
            submit: async () => ({
                txid: 'txAA',
                indexed: { status: 'valid', statusKnown: true, statusSource: 'indexer' },
                policy: { action: 'SEND', windowUsage: { count: 1 } },
            }),
        }),
    });
    const server = buildServer({ sdkFactory, wallet: { wif: 'WIF', policy: POLICY } });
    const client = new Client({ name: 'indexed-status', version: '0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
}

describe('MCP server (write tools)', () => {
    it('reports the known indexed verdict returned by AgentSession', async () => {
        const client = await connected();
        const response = await client.callTool({
            name: 'submit_action',
            arguments: { coin: 'TDOGE', action: 'SEND', params: { tick: 'TOK', amount: '5' } },
        });
        const body = JSON.parse(response.content[0].text);
        expect(body).to.include({ status: 'valid', statusKnown: true, statusSource: 'indexer' });
    });
});
