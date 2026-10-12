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
 * XChain Platform SDK - Hub Connector
 *
 * Connects to xchain-hub for service discovery and config resolution
 *
 ********************************************************************/

const coins = require('../../coins');
const { isHttpsUrl } = require('../../utils/endpoints.js');

// Local { coin -> consensusHash } per network, computed on first use. The bundled
// coin registry cannot change under a running process, so re-hashing it on every
// config poll would be pure waste.
const LOCAL_CONSENSUS_HASHES = {};
function localConsensusHashes(network){
    if(!LOCAL_CONSENSUS_HASHES[network]) LOCAL_CONSENSUS_HASHES[network] = coins.consensusHashes(network);
    return LOCAL_CONSENSUS_HASHES[network];
}

// Fold a getallconfigs delta (only the rows that changed since our cursor) into
// the cached nested config map, mutating and returning `base`. The hub's configs
// table is upsert-only (rows are never deleted), so applying successive deltas
// reconstructs the tree a full fetch would have produced -- PROVIDED no row is
// skipped by the cursor. The hub's cursor is inclusive (`>=` on whole-second
// time, item #2265) so the boundary second is re-delivered, and getAllConfig
// still re-requests one second behind the watermark to stay loss-free against
// an older hub that compared `>` (see the cursor comment there). This merge is
// idempotent, which is what makes either overlap safe. Keys come from remote
// JSON, so it walks own keys only and ignores prototype-sensitive names.
function mergeConfigDelta(base, delta){
    for(const coin of safeConfigKeys(delta)){
        const coinBase = ownConfigBranch(base, coin);
        for(const network of safeConfigKeys(delta[coin])){
            const networkBase = ownConfigBranch(coinBase, network);
            for(const module of safeConfigKeys(delta[coin][network])){
                const moduleBase = ownConfigBranch(networkBase, module);
                const params = delta[coin][network][module];
                for(const param of safeConfigKeys(params)){
                    moduleBase[param] = params[param];
                }
            }
        }
    }
    return base;
}

// Names that reach Object.prototype or a constructor when used as a key.
const PROTOTYPE_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);
function isUnsafeConfigKey(key){
    return PROTOTYPE_KEYS.includes(key);
}

// Own enumerable keys of a config level, minus prototype-sensitive ones; none for a non-object level.
function safeConfigKeys(level){
    if(!level || typeof level !== 'object' || Array.isArray(level)) return [];
    return Object.keys(level).filter((key) => !isUnsafeConfigKey(key));
}

// The child map at `key`, reused only when it is an own plain-object property, else a fresh one.
function ownConfigBranch(obj, key){
    const own = Object.prototype.hasOwnProperty.call(obj, key);
    if(own && obj[key] && typeof obj[key] === 'object' && !Array.isArray(obj[key])) return obj[key];
    obj[key] = {};
    return obj[key];
}

// The hub reports a config-DB read failure as an HTTP-200 JSON-RPC result of
// the shape { error: "..." } with no configs member (xchain-hub api.js
// getallconfigs); a legitimate config tree can never match this shape.
function isHubErrorEnvelope(result){
    return !!(result && typeof result === 'object' && result.error && !result.configs);
}

// Read { seq, watermark } off a newer hub's { configs, seq, watermark } envelope.
// watermark is null when the envelope is the bare map or carries no watermark
// (both are the full tree); seq is 0 when absent.
function hubEnvelopeMarks(result){
    let wrapped = result && typeof result === 'object' && result.configs && typeof result.configs === 'object' && ('seq' in result);
    if(!wrapped) return { seq: 0, watermark: null };
    let watermark = ('watermark' in result && result.watermark !== null && result.watermark !== undefined)
        ? (Number(result.watermark) || 0) : null;
    return { seq: Number(result.seq) || 0, watermark };
}

// Per-request axios options carrying the injected agents. The hub
// has several URLs and they can differ in scheme, so the choice is made per
// URL rather than once per client.
function agentOptsFor(url, pool){
    if(!pool) return { proxy: false };
    let isHttps = isHttpsUrl(url);
    let agent = isHttps ? pool.httpsAgent : pool.httpAgent;
    if(!agent) return { proxy: false };
    return isHttps ? { proxy: false, httpsAgent: agent } : { proxy: false, httpAgent: agent };
}

// Build the network string → hub config keys mapping (bitcoin-testnet →
// { coin: 'bitcoin', network: 'testnet' }) from the coin registry, so a coin
// added to the registry gets hub endpoint discovery with no edit here.
function buildNetworkMap(registry){
    const map = {};
    for(const tick of registry.ALLOWED_COINS){
        const full = registry.COIN_FULL_NAME[tick];
        for(const network of registry.NETWORKS)
            map[full + '-' + network] = { coin: full, network };
    }
    return map;
}

const NETWORK_MAP = buildNetworkMap(coins);

module.exports = {
    LOCAL_CONSENSUS_HASHES,
    localConsensusHashes,
    mergeConfigDelta,
    isUnsafeConfigKey,
    ownConfigBranch,
    isHubErrorEnvelope,
    hubEnvelopeMarks,
    agentOptsFor,
    buildNetworkMap,
    NETWORK_MAP
};
