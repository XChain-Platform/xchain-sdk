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
 ********************************************************************/

'use strict';

// SDK pieces the MCP server needs, resolved for both lives the server leads:
// installed from npm (xchain-mcp depends on @dankest-llc/xchain-sdk, so the named
// deep require wins) and in-repo under xchain-sdk/mcp/ (no installed copy of the
// package exists, so fall back to the sibling source tree). This file ships in the
// package allowlist beside server.js, which requires it at load.

// Deep require on purpose: the server needs only the class, not index.js and its
// REPL/ws baggage.
let XChainSDKClass;
try {
    XChainSDKClass = require('@dankest-llc/xchain-sdk/src/XChainSDK.js');
} catch {
    XChainSDKClass = require('../src/XChainSDK.js');
}

// The ceiling gate must apply the evaluator's own notion of an enforceable cap,
// not a second one. The installed form names the evaluator's older path, which
// every published SDK release still resolves, so this package keeps working
// against 0.18.0 as well.
let hasEnforceableCap;
try {
    ({ hasEnforceableCap } = require('@dankest-llc/xchain-sdk/src/cosigner/policyEvaluator.js'));
} catch {
    ({ hasEnforceableCap } = require('../src/cosigner/policy_evaluator.js'));
}

// Optional pieces: an installed SDK that predates a module or export leaves the
// matching check unrun rather than throwing a TypeError on every call.
function optional(ids, member) {
    for (const id of ids) {
        try {
            const loaded = require(id);
            return member ? loaded[member] : loaded;
        } catch { /* try the next resolution */ }
    }
    return null;
}

// The serialized-boundary halt gate submitAction crosses before the encoder is
// contacted; compose_action crosses it too.
const LifecycleManagerClass = optional([
    '@dankest-llc/xchain-sdk/src/carrier/lifecycle_manager.js',
    '../src/carrier/lifecycle_manager.js',
]);
// The mainnet launch gate submitAction runs first. An installed SDK old enough to
// lack this module has no launch gate in its own submitAction either, so compose
// and submit still refuse alike.
const assertMainnetLaunched = optional([
    '@dankest-llc/xchain-sdk/src/protocol/mainnet_launch.js',
    '../src/protocol/mainnet_launch.js',
], 'assertMainnetLaunched');
// AgentSession.validatePolicy: an installed SDK that predates the export still
// validates per call.
const AgentSessionClass = optional([
    '@dankest-llc/xchain-sdk/src/cosigner/agent_session.js',
    '../src/cosigner/agent_session.js',
]);

const valueDerivability = optional([
    '@dankest-llc/xchain-sdk/src/cosigner/policy/value_derivability.js',
    '../src/cosigner/policy/value_derivability.js',
]);
const LEGACY_UNBOUNDABLE = new Set(['SWEEP', 'AIRDROP', 'DIVIDEND', 'BATCH', 'CALLBACK', 'EXECUTE']);

// Explorer-style coin prefixes to SDK network strings. Mainnet/testnet default
// to the public hosts (SDK zero-config); R* regtest prefixes get only a localhost
// explorer, so writes need ENCODER_URL (usual SDK env vars).
const COIN_NETWORKS = {
    BTC: 'bitcoin-mainnet', TBTC: 'bitcoin-testnet', RBTC: 'bitcoin-regtest',
    LTC: 'litecoin-mainnet', TLTC: 'litecoin-testnet', RLTC: 'litecoin-regtest',
    DOGE: 'dogecoin-mainnet', TDOGE: 'dogecoin-testnet', RDOGE: 'dogecoin-regtest',
};

// A tick-to-cap table bounds every tick only through its own '*' entry: the evaluator
// resolves a cap per tick and a tick with no entry and no '*' is uncapped, so a table
// naming only some ticks leaves every other token the wallet holds unbounded.
function hasWildcardCap(table) {
    return !!table && typeof table === 'object' && Object.prototype.hasOwnProperty.call(table, '*')
        && hasEnforceableCap({ '*': table['*'] });
}

// Allowed actions that no amount cap reaches for every tick. The evaluator reads
// maxPerAction[ACTION] by exact own key, with the allowlist upper-cased, and
// applies maxPerWindow.perTick to every amount-bearing action, so a perTick '*' entry
// covers all of them and otherwise each action needs its own '*' entry.
function uncappedActions(policy) {
    if (!Array.isArray(policy.allowedActions)) return [];
    const unboundable = unboundableActions(policy);
    if (unboundable.length)
        throw new Error('mcp wallet policy allows ' + unboundable.join(', ')
            + ', whose spend no amount cap can bind on this rail: remove them from allowedActions (fail-closed)');
    if (hasWildcardCap(policy.maxPerWindow && policy.maxPerWindow.perTick)) return [];
    const table = policy.maxPerAction;
    const own = (key) => (table && typeof table === 'object'
        && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined);
    return [...new Set(policy.allowedActions.map((action) => String(action).toUpperCase()))]
        .filter((action) => !hasWildcardCap(own(action)));
}

// Allowed actions whose spend cannot be bounded by an amount cap on this rail.
// Unknown actions fail closed when the installed SDK exposes its classification table.
function unboundableActions(policy) {
    if (!Array.isArray(policy.allowedActions)) return [];
    const actions = [...new Set(policy.allowedActions.map((action) => String(action).toUpperCase()))];
    if (!valueDerivability || typeof valueDerivability.isAlwaysUnbounded !== 'function')
        return actions.filter((action) => LEGACY_UNBOUNDABLE.has(action));
    const table = valueDerivability.TABLE || {};
    return actions.filter((action) => !Object.prototype.hasOwnProperty.call(table, action)
        || valueDerivability.isAlwaysUnbounded(action));
}

module.exports = {
    AgentSessionClass,
    COIN_NETWORKS,
    LifecycleManagerClass,
    XChainSDKClass,
    assertMainnetLaunched,
    hasEnforceableCap,
    unboundableActions,
    uncappedActions,
};
