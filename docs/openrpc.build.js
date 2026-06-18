#!/usr/bin/env node
/*
 * Copyright © 2025–2026 Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Licensed under the GNU Affero GPL v3.0 or later; see LICENSE.md.
 * A commercial license is available - contact legal@dankest.llc.
 *
 * Generates docs/openrpc.json (OpenRPC 1.3.2) for the SDK's standalone
 * JSON-RPC server (src/api.js, `npm run api`). METHODS below mirrors the
 * controller object; test/unit/openrpc-coverage.test.js fails on drift.
 *
 * Run: node docs/openrpc.build.js
 */
const fs = require('fs');
const path = require('path');

// name, summary  (params are summary-level; the SDK library docs carry detail)
const METHODS = [
    ['ping', 'Health check (the only method that does not require auth).'],
    // Actions
    ['create_action', 'Generate an XChain ACTION string from an action name + fields (auto-selects the smallest wire format).'],
    ['validate_action', 'Validate action fields without generating output.'],
    ['get_actions', 'List the supported ACTION types.'],
    ['get_action_formats', 'Versioned wire-format templates for an action.'],
    ['get_action_fields', 'Field names/constraints for an action.'],
    // Encoder passthrough
    ['encode_tx', 'Encode an ACTION string into an unsigned PSBT via xchain-encoder.'],
    ['spend_p2sh', 'Build the P2SH/P2WSH reveal (tx2) transaction.'],
    ['ping_encoder', 'Health-check the configured encoder.'],
    // Hub
    ['ping_hub', 'Health-check the configured hub.'],
    ['get_hub_config', 'Hub service-discovery config (getallconfigs).'],
    // Explorer queries
    ['get_balances', 'Token balances for an address.'],
    ['get_address', 'Address summary.'],
    ['get_holders', 'Holders of a token.'],
    ['get_credits', 'Ledger credits.'],
    ['get_debits', 'Ledger debits.'],
    ['get_escrows', 'Escrowed balances.'],
    ['get_token', 'Token detail.'],
    ['get_tokens', 'Token search.'],
    ['get_issues', 'ISSUE actions.'],
    ['get_transaction', 'Transaction lookup.'],
    ['get_action', 'One action with decoded data.'],
    ['get_block', 'Block summary.'],
    ['get_history', 'Combined action history.'],
    ['get_addresses', 'ADDRESS actions.'],
    ['get_airdrops', 'AIRDROP actions.'],
    ['get_batches', 'BATCH actions.'],
    ['get_broadcasts', 'BROADCAST actions.'],
    ['get_callbacks', 'CALLBACK actions.'],
    ['get_destroys', 'DESTROY actions.'],
    ['get_dispensers', 'DISPENSER actions.'],
    ['get_dispenses', 'Dispense events.'],
    ['get_dividends', 'DIVIDEND actions.'],
    ['get_fees', 'Protocol fee payments.'],
    ['get_files', 'FILE actions.'],
    ['get_links', 'LINK actions.'],
    ['get_lists', 'LIST actions.'],
    ['get_messages', 'MESSAGE actions.'],
    ['get_mints', 'MINT actions.'],
    ['get_orders', 'ORDER actions.'],
    ['get_sends', 'SEND actions.'],
    ['get_sleeps', 'SLEEP actions.'],
    ['get_swaps', 'SWAP actions.'],
    ['get_sweeps', 'SWEEP actions.'],
    // Markets
    ['get_markets', 'All trading pairs.'],
    ['get_market', 'Market summary for a pair.'],
    ['get_market_history', 'Trade history for a pair.'],
    ['get_market_orders', 'Open orders for a pair.'],
    ['get_orderbook', 'Aggregated order book.'],
    // Misc
    ['get_status', 'Explorer status.'],
    ['search', 'Search addresses, tokens, broadcasts, transactions.'],
];

const spec = {
    openrpc: '1.3.2',
    info: {
        title: 'XChain SDK API',
        version: '1.0.0',
        description: 'JSON-RPC 2.0 server (POST /) exposing xchain-sdk: action generation, PSBT '
            + 'encoding via xchain-encoder, and explorer/hub queries. Self-hosted (`npm run api` in '
            + 'xchain-sdk): there is no public deployment; agents talking to the public platform '
            + 'should use the explorer REST API or the SDK as a library instead. Auth fails closed: '
            + 'every method except ping requires `Authorization: Bearer <SDK_API_KEY>`. Errors follow '
            + 'JSON-RPC 2.0 ({code, message}); registry: https://docs.xchain.io/protocol/Error_Codes.md. '
            + 'LLM-friendly docs: https://docs.xchain.io/llms.txt',
        license: { name: 'AGPL-3.0-or-later', url: 'https://docs.xchain.io/legal/LICENSING.md' },
    },
    servers: [{ name: 'local', url: 'http://localhost:3005/' }],
    methods: METHODS.map(([name, summary]) => ({
        name, summary,
        paramStructure: 'by-name',
        params: [{ name: 'params', required: false, schema: { type: 'object', description: 'method parameters (see the SDK method of the same camelCase name)' } }],
        result: { name: 'result', schema: { type: 'object' } },
        'x-auth': name === 'ping' ? undefined : 'Authorization: Bearer SDK_API_KEY',
    })),
};

const out = path.join(__dirname, 'openrpc.json');
fs.writeFileSync(out, JSON.stringify(spec, null, 2) + '\n');
console.log(`wrote ${out}: ${spec.methods.length} methods`);
