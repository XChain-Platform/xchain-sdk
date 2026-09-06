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
 * XChain MCP server: read-only Model Context Protocol tools over the
 * public XChain Platform (or a local regtest stack). Phase B-read of the
 * AI-agent readiness program: every tool is a query; nothing here touches
 * keys, signs, or submits. Write tools arrive separately, gated on
 * AgentSession policies.
 *
 * buildServer() is transport-agnostic and takes an injectable SDK factory
 * so tests can run against a stub. mcp/cli.js wires stdio.
 *
 * WRITE TOOLS exist only when the OPERATOR configures a wallet
 * (options.wallet = { wif, policy }, from env in cli.js; never from the
 * model conversation), and every submit goes through AgentSession policy
 * enforcement. No wallet config → the write tools are not even listed.
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { z } = require('zod');
const { version: SDK_VERSION } = require('./package.json');

// The SDK class, resolved for both lives this file leads: installed from npm
// (xchain-mcp depends on @dankest-llc/xchain-sdk, so the named deep require
// wins) and in-repo under xchain-sdk/mcp/ (no installed copy of the package
// exists, so fall back to the sibling source tree). Deep require on purpose:
// the server needs only the class, not index.js and its REPL/ws baggage.
let XChainSDKClass;
try {
    XChainSDKClass = require('@dankest-llc/xchain-sdk/src/XChainSDK.js');
} catch {
    XChainSDKClass = require('../src/XChainSDK.js');
}

// Explorer-style coin prefixes → SDK network strings. Mainnet/testnet default
// to the public *.xchain.io hosts (SDK zero-config); R* regtest prefixes
// default to localhost services, overridable via the usual SDK env vars.
const COIN_NETWORKS = {
    BTC: 'bitcoin-mainnet', TBTC: 'bitcoin-testnet', RBTC: 'bitcoin-regtest',
    LTC: 'litecoin-mainnet', TLTC: 'litecoin-testnet', RLTC: 'litecoin-regtest',
    DOGE: 'dogecoin-mainnet', TDOGE: 'dogecoin-testnet', RDOGE: 'dogecoin-regtest',
};

const DOCS_BASE = 'https://docs.xchain.io';

// Key ordering is not part of what a submission MEANS, and the caller is a model
// re-emitting JSON, so the same request must hash the same however its object
// keys came out this time. Sorts every object key at every depth and leaves array
// order alone (that IS meaning). Cycles cannot occur: the value came off the wire
// as JSON.
function canonicalJson(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
    if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
    return '{' + Object.keys(value).sort()
        .map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k]))
        .join(',') + '}';
}

// The default idempotency key for a submit_action call: a hash of exactly what
// the submission does. AgentSession REQUIRES a stable key (POLICY_IDEMPOTENCY_
// REQUIRED) because a submit can throw after the transaction already landed, and
// the thing that retries on this rail is a model, which re-derives the same
// arguments rather than remembering a key it minted. Hashing the arguments is
// therefore the key the caller would have supplied if it could: an identical
// retry is refused and handed the prior txid instead of paying twice. A caller
// that MEANS to repeat a payment passes its own idempotency_key.
function derivedIdempotencyKey(coin, action, params) {
    return 'mcp-' + crypto.createHash('sha256')
        .update(canonicalJson({ coin, action, params: params ?? {} }))
        .digest('hex');
}

const coinParam = z.enum(Object.keys(COIN_NETWORKS))
    .describe('Chain + network: BTC/LTC/DOGE mainnet, T prefix = testnet, R prefix = local regtest');
const pageOpts = {
    page: z.number().int().min(1).optional().describe('Page number'),
    limit: z.number().int().min(1).max(500).optional().describe('Rows per page'),
};

function buildServer(options = {}) {
    // sdkFactory(network) → XChainSDK-compatible instance. Lazily created and
    // cached per coin so listing tools never opens a connection.
    const sdkFactory = options.sdkFactory
        || ((network) => new XChainSDKClass({ network }));
    const fetchImpl = options.fetch || (typeof fetch === 'function' ? fetch : null);
    const sdks = new Map();
    const sdkFor = (coin) => {
        if (!sdks.has(coin)) sdks.set(coin, sdkFactory(COIN_NETWORKS[coin]));
        return sdks.get(coin);
    };
    const explorerBaseUrl = (sdk) => {
        const e = sdk.explorer || {};
        const base = e.baseUrl || 'localhost';
        return base.startsWith('http') ? base : 'http://' + base + ':' + (e.port || 8080);
    };

    const server = new McpServer({ name: 'xchain', version: SDK_VERSION });

    // Every tool returns the raw JSON the platform returned, as text. Amounts
    // are arbitrary-precision decimal STRINGS; never parse them as floats.
    const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 1) }] });
    // `extra` is opt-in per call site, never a blanket spread of err.details: an
    // error's details are shaped by whatever threw, and this rail answers a model.
    const fail = (err, extra) => ({
        isError: true,
        content: [{ type: 'text', text: JSON.stringify(Object.assign(
            { error: err.message || String(err), code: err.code || err.name || 'ERROR' }, extra || {})) }],
    });
    const tool = (name, description, schema, handler) => {
        server.registerTool(name, {
            description,
            inputSchema: schema,
            annotations: { readOnlyHint: true, openWorldHint: true },
        }, async (args) => {
            try { return ok(await handler(args)); } catch (err) { return fail(err); }
        });
    };

    /* ── platform / network ─────────────────────────────────────────── */
    tool('get_status', 'Explorer status and chain configuration for a coin.',
        { coin: coinParam },
        ({ coin }) => sdkFor(coin).getStatus());

    tool('get_fee_schedule', 'Protocol fee schedule + current oracle prices (what an action will cost).',
        { coin: coinParam },
        ({ coin }) => sdkFor(coin).getFeeSchedule());

    /* ── tokens ─────────────────────────────────────────────────────── */
    tool('get_token', 'Token detail: supply, decimals, issuer, NFT/registry surfaces. `tick` is the token symbol (there is no "asset" field on XChain).',
        { coin: coinParam, tick: z.string().describe('Token tick (symbol)') },
        ({ coin, tick }) => sdkFor(coin).getToken(tick));

    tool('search_tokens', 'Search tokens. type: token = by tick prefix, subtoken = children of a parent tick, nft = unique tokens only, address = tokens issued by an address, block = tokens issued in a block.',
        { coin: coinParam, query: z.string(), type: z.enum(['token', 'subtoken', 'nft', 'address', 'block']).default('token'), ...pageOpts },
        ({ coin, query, type, page, limit }) => sdkFor(coin).getTokens(query, type, { page, limit }));

    tool('get_holders', 'Holders of a token with balances.',
        { coin: coinParam, tick: z.string(), ...pageOpts },
        ({ coin, tick, page, limit }) => sdkFor(coin).getHolders(tick, { page, limit }));

    tool('get_project', 'Project registry roster: the owner-attested list of a project\'s official tokens.',
        { coin: coinParam, tick: z.string().describe('The project token tick') },
        ({ coin, tick }) => sdkFor(coin).getProject(tick));

    /* ── addresses / ledger ─────────────────────────────────────────── */
    tool('get_balances', 'All token balances for an address. Amounts are decimal strings.',
        { coin: coinParam, address: z.string() },
        ({ coin, address }) => sdkFor(coin).getBalances(address));

    tool('get_address', 'Address summary.',
        { coin: coinParam, address: z.string() },
        ({ coin, address }) => sdkFor(coin).getAddress(address));

    tool('get_history', 'Combined action history for an address, token, or block.',
        { coin: coinParam, query: z.string(), type: z.enum(['address', 'token', 'block']), ...pageOpts },
        ({ coin, query, type, page, limit }) => sdkFor(coin).getHistory(query, type, { page, limit }));

    /* ── actions / blocks ───────────────────────────────────────────── */
    tool('get_action', 'One action with full decoded data, by action index.',
        { coin: coinParam, action_index: z.number().int().min(0) },
        ({ coin, action_index }) => sdkFor(coin).getAction(action_index));

    tool('get_block', 'Block summary by height.',
        { coin: coinParam, block: z.number().int().min(0) },
        ({ coin, block }) => sdkFor(coin).getBlock(block));

    tool('search', 'General search across addresses, tokens, broadcasts, and transactions.',
        { coin: coinParam, query: z.string(), type: z.enum(['address', 'token', 'broadcast', 'transaction']).optional() },
        ({ coin, query, type }) => sdkFor(coin).search(query, type));

    /* ── dispensers / markets ───────────────────────────────────────── */
    tool('get_dispensers', 'DISPENSER listings (on-chain vending machines: send coin, receive tokens atomically). Useful for finding things an agent can buy.',
        { coin: coinParam, query: z.string(), type: z.enum(['address', 'token', 'block', 'source', 'destination']), ...pageOpts },
        ({ coin, query, type, page, limit }) => sdkFor(coin).getDispensers(query, type, { page, limit }));

    tool('get_markets', 'Trading pairs on the DEX (optionally for one tick).',
        { coin: coinParam, tick: z.string().optional() },
        ({ coin, tick }) => sdkFor(coin).getMarkets(tick));

    tool('get_market', 'Market summary for a pair.',
        { coin: coinParam, tick1: z.string(), tick2: z.string() },
        ({ coin, tick1, tick2 }) => sdkFor(coin).getMarket(tick1, tick2));

    tool('get_orderbook', 'Aggregated order book for a pair.',
        { coin: coinParam, tick1: z.string(), tick2: z.string() },
        ({ coin, tick1, tick2 }) => sdkFor(coin).getOrderbook(tick1, tick2));

    /* ── smart contracts ────────────────────────────────────────────── */
    tool('get_contract', 'Deployed smart contract detail, by the DEPLOY action index.',
        { coin: coinParam, contract_action_index: z.number().int().min(0) },
        ({ coin, contract_action_index }) => sdkFor(coin).getContract(contract_action_index));

    tool('get_contract_state', 'Contract state: all keys, or one key.',
        { coin: coinParam, contract_action_index: z.number().int().min(0), key: z.string().optional() },
        ({ coin, contract_action_index, key }) => sdkFor(coin).getContractState(contract_action_index, key));

    // getExecutions is (query, type, opts): the explorer's filtered route is
    // /executions/{QUERY}/{TYPE} and the type segment is required, so the
    // contract action index is the QUERY and 'contract' names its index.
    // Passing opts in the type slot builds '/executions/42/[object Object]'.
    tool('get_executions', 'Executions of a contract.',
        { coin: coinParam, contract_action_index: z.number().int().min(0), ...pageOpts },
        ({ coin, contract_action_index, page, limit }) => sdkFor(coin).getExecutions(contract_action_index, 'contract', { page, limit }));

    /* ── attestations / validators / checkpoints ────────────────────── */
    tool('get_attestations', 'ATTEST v0 requests + v1 responses, including LLM attestations contracts requested via xchain.attestation.request. Omit BOTH query and type for the unfiltered list; whenever query is given, type names the index it filters on and is required.',
        { coin: coinParam, query: z.string().optional(), type: z.enum(['block', 'address', 'contract']).optional(), ...pageOpts },
        ({ coin, query, type, page, limit }) => {
            // The filtered route is /attestations/{QUERY}/{TYPE} with the type
            // segment required; the two fields are independently optional here,
            // so refuse the pair the SDK would render as '/attestations/42/undefined'.
            // registerTool takes a raw Zod shape, so cross-field rules live here.
            if (query && !type)
                throw Object.assign(
                    new Error('get_attestations: type is required when query is given (one of block, address, contract); omit both for the unfiltered list'),
                    { code: 'INVALID_ARGUMENT' });
            return sdkFor(coin).getAttestations(query, type, { page, limit });
        });

    tool('get_validators', 'Active validators and their staked capabilities.',
        { coin: coinParam },
        ({ coin }) => sdkFor(coin).getValidators());

    tool('verify_checkpoint', 'Fetch a quorum-signed state checkpoint and verify its Ed25519 signatures CLIENT-SIDE (does not trust the explorer\'s verified flag).',
        { coin: coinParam, block_index: z.number().int().min(0) },
        ({ coin, block_index }) => {
            const sdk = sdkFor(coin);
            return sdk.checkpoint.fetchAndVerifyCheckpoint(explorerBaseUrl(sdk), coin, block_index, fetchImpl || undefined);
        });

    /* ── write tools (operator-configured wallet only) ──────────────── */

    const wallet = options.wallet || null;
    if (wallet && (!wallet.wif || !wallet.policy))
        throw new Error('mcp wallet config requires both wif and policy (fail-closed)');
    if (wallet && wallet.policy.confirmAbove)
        throw new Error('confirmAbove is not supported in the MCP policy file (no human in this loop): use hard caps instead');
    // The confirmAbove gate above removes the human-in-the-loop approval on the stated
    // grounds that hard caps replace it, so require that a binding amount ceiling
    // actually exists. Without this, a policy like { allowedActions: ['SEND'] } is
    // accepted and every amount gate in policyEvaluator (maxPerAction / perTick) is
    // skipped, leaving an LLM-driven submit_action able to SEND unbounded amounts to
    // any destination. This is policyEvaluator's hasAmountLimit test with ONE DELIBERATE
    // OMISSION: the evaluator also accepts `|| !!policy.confirmAbove`, and this gate must
    // NOT. confirmAbove is rejected outright a few lines above, because there is no human
    // in this loop to answer it, so on this rail it can never be a binding ceiling.
    // Copying the evaluator's third clause here to "fix the divergence" would let a
    // confirmAbove-only policy satisfy the hard-cap requirement and reopen exactly the
    // unbounded-spend hole the confirmAbove rejection was traded away to close. The
    // divergence is the point; test/unit/mcp.test.js pins it. maxPerWindow.maxActions is
    // likewise a COUNT cap, not an amount ceiling, and does not satisfy this.
    if (wallet) {
        const pol = wallet.policy;
        const hasAmountCap = !!pol.maxPerAction
            || !!(pol.maxPerWindow && pol.maxPerWindow.perTick);
        if (!hasAmountCap)
            throw new Error('mcp wallet policy must set a binding amount ceiling '
                + '(maxPerAction or maxPerWindow.perTick): the MCP rail has no human in the loop, '
                + 'so a policy with no spend ceiling is refused (fail-closed)');
    }

    // One AgentSession per coin, lazily created: same key, per-network address,
    // per-address window state. Policy is shared across chains.
    const sessions = new Map();
    const sessionFor = (coin) => {
        if (!wallet) return null;
        if (!sessions.has(coin))
            sessions.set(coin, sdkFor(coin).agentSession(wallet.wif, wallet.policy));
        return sessions.get(coin);
    };

    if (wallet) {
        tool('get_agent_wallet', 'The configured agent wallet: address, balances, and current policy window usage for a coin.',
            { coin: coinParam },
            async ({ coin }) => {
                const s = sessionFor(coin);
                return {
                    address: s.address,
                    balances: await s.getBalances(),
                    window_usage: s._windowUsage(),
                };
            });

        server.registerTool('submit_action', {
            description: 'Compose, policy-check, sign, broadcast an XChain action and wait for the indexer. '
                + 'Enforced by the operator-configured AgentSession policy: out-of-policy actions are refused '
                + 'before signing, with a POLICY_* code. Treat policy refusals as final, not retryable. '
                + 'At most once: repeating a call with the same coin, action and params is REFUSED with '
                + 'POLICY_DUPLICATE_SUBMIT and the original txid, so a call that timed out is safe to repeat '
                + 'and will never pay twice. To make a DELIBERATE second identical payment, pass a new '
                + 'idempotency_key.',
            inputSchema: {
                coin: coinParam,
                action: z.string().describe('ACTION name, e.g. SEND, MINT, EXECUTE'),
                params: z.record(z.string(), z.any()).describe('Action parameters (e.g. {tick, amount, destination}). Amounts are decimal strings.'),
                idempotency_key: z.string().min(1).optional().describe(
                    'Optional. Defaults to a hash of coin+action+params, which is what makes a repeated call safe. '
                    + 'Supply a NEW value only to make a second, deliberately identical payment; supply the SAME '
                    + 'value to retry one call without risking a double spend.'),
            },
            annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
        }, async ({ coin, action, params, idempotency_key: idempotencyKey }) => {
            const ACTION = String(action).toUpperCase();
            try {
                // Third argument: submit(actionData, encoderOpts, submitOpts). Passing
                // nothing here is what left this tool refusing every call with
                // POLICY_IDEMPOTENCY_REQUIRED under the default policy.
                const result = await sessionFor(coin).submit(
                    { action: ACTION, params },
                    {},
                    { idempotencyKey: idempotencyKey || derivedIdempotencyKey(coin, ACTION, params) });
                return ok({ txid: result.txid, status: result.status, policy: result.policy });
            } catch (err) {
                // A duplicate refusal carries the earlier txid. Without it the caller
                // is told only that it already paid, with no way to find the payment
                // and resume waiting on it, which is the retry this refusal exists to
                // replace. Nothing else is copied out of details.
                const txid = err && err.details && err.details.txid;
                return txid ? fail(err, { txid }) : fail(err);
            }
        });
    }

    tool('compose_action', 'Compose an unsigned transaction for an XChain action: returns the ACTION string and an unsigned PSBT. Nothing is signed or broadcast; the caller signs externally.'
        + (wallet ? ' Defaults to the configured agent wallet\'s pubkey.' : ' Requires pubkey (no wallet is configured).'),
        {
            coin: coinParam,
            action: z.string().describe('ACTION name, e.g. SEND, MINT'),
            params: z.record(z.string(), z.any()).describe('Action parameters'),
            pubkey: z.string().optional().describe('Sender address/pubkey for UTXO selection' + (wallet ? ' (defaults to the agent wallet)' : ' (required)')),
        },
        async ({ coin, action, params, pubkey }) => {
            const sender = pubkey || (wallet ? sessionFor(coin).address : null);
            if (!sender) throw Object.assign(new Error('pubkey is required: no agent wallet is configured'), { code: 'MISSING_PUBKEY' });
            const sdk = sdkFor(coin);
            const actionResult = await sdk.createAction({ action: String(action).toUpperCase(), params });
            const actionString = actionResult && actionResult.actionString !== undefined ? actionResult.actionString : actionResult;
            const tx = await sdk.encodeTx({ pubkey: sender, data: actionString });
            return { action_string: actionString, psbt: tx.psbt, encoding: tx.encoding, signed: false };
        });

    /* ── documentation resources ────────────────────────────────────── */
    const docResource = (name, uri, url, description) => {
        server.registerResource(name, uri, { description, mimeType: 'text/plain' }, async () => {
            if (!fetchImpl) throw new Error('no fetch implementation available');
            const res = await fetchImpl(url);
            if (!res.ok) throw new Error(`docs fetch failed: HTTP ${res.status}`);
            return { contents: [{ uri, mimeType: 'text/plain', text: await res.text() }] };
        });
    };
    docResource('xchain-docs-index', 'xchain://docs/llms.txt', `${DOCS_BASE}/llms.txt`,
        'Curated XChain documentation index for LLMs');
    docResource('xchain-docs-full', 'xchain://docs/llms-full.txt', `${DOCS_BASE}/llms-full.txt`,
        'Complete XChain documentation corpus (large)');

    return server;
}

module.exports = { buildServer, COIN_NETWORKS };
