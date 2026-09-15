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
// idempotent, which is what makes either overlap safe.
function mergeConfigDelta(base, delta){
    for(let coin in delta){
        if(!base[coin]) base[coin] = {};
        for(let network in delta[coin]){
            if(!base[coin][network]) base[coin][network] = {};
            for(let module in delta[coin][network]){
                if(!base[coin][network][module]) base[coin][network][module] = {};
                let params = delta[coin][network][module];
                for(let param in params){
                    base[coin][network][module][param] = params[param];
                }
            }
        }
    }
    return base;
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
    let isHttps = String(url).startsWith('https');
    let agent = isHttps ? pool.httpsAgent : pool.httpAgent;
    if(!agent) return { proxy: false };
    return isHttps ? { proxy: false, httpsAgent: agent } : { proxy: false, httpAgent: agent };
}

// Network string → hub config keys mapping
const NETWORK_MAP = {
    'bitcoin-mainnet':   { coin: 'bitcoin',  network: 'mainnet' },
    'bitcoin-testnet':   { coin: 'bitcoin',  network: 'testnet' },
    'bitcoin-regtest':   { coin: 'bitcoin',  network: 'regtest' },
    'litecoin-mainnet':  { coin: 'litecoin', network: 'mainnet' },
    'litecoin-testnet':  { coin: 'litecoin', network: 'testnet' },
    'litecoin-regtest':  { coin: 'litecoin', network: 'regtest' },
    'dogecoin-mainnet':  { coin: 'dogecoin', network: 'mainnet' },
    'dogecoin-testnet':  { coin: 'dogecoin', network: 'testnet' },
    'dogecoin-regtest':  { coin: 'dogecoin', network: 'regtest' }
};

module.exports = {
    LOCAL_CONSENSUS_HASHES,
    localConsensusHashes,
    mergeConfigDelta,
    isHubErrorEnvelope,
    hubEnvelopeMarks,
    agentOptsFor,
    NETWORK_MAP
};
