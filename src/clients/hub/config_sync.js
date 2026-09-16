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

const axios = require('axios');
const { SDKHubError } = require('../../utils/errors.js');
const coins = require('../../coins');
const {
    localConsensusHashes,
    mergeConfigDelta,
    isHubErrorEnvelope,
    hubEnvelopeMarks,
    agentOptsFor
} = require('./config_envelope.js');
const { getLogger } = require('../../observability/logger.js');
const log = getLogger('xchain-sdk:hub');

async function fetchConfigResult(connector, url, cursorValid, sinceCursor, headers) {
    let result = await connector.postGetAllConfigs(url, sinceCursor, headers);
    if (result === undefined) return undefined;
    // The hub returns its FAILURE payload through the same JSON-RPC
    // `result` member ({ error: "..." }, no configs), with no
    // JSON-RPC error member and a 2xx status, so it is indistinguishable
    // from success at the HTTP layer. Treat it as a failed endpoint:
    // record it and continue the failover loop, rather than caching the
    // error object AS the config tree (which then strands
    // extractServiceEndpoints with an empty map and no diagnostic).
    if (isHubErrorEnvelope(result)) throw new Error('hub returned error result: ' + result.error);
    if (!cursorValid) {
        // Full tree from an endpoint other than the cursor's origin (failover,
        // or the first fetch): replace the cache, never merge across hubs.
        connector.lastWatermark = 0;
        connector.configs       = null;
    } else if (connector.hubConfigRegressed(result)) {
        // Hub restart / restore from an older snapshot: the served watermark or
        // seq is BELOW what this endpoint gave us before. The delta we asked for
        // (cursor from the lost window) cannot carry rows the restored hub now
        // holds at an OLDER updated_at, and mergeConfigDelta only upserts, so a
        // merge would serve lost-window values forever with a fresh lastFetch.
        // Mirror the indexer's HUB CONFIG REGRESSION handling: alarm (a hub that
        // lost config state is an operator event), drop the cache, reset the
        // cursor, and re-fetch the full tree from the same endpoint once.
        let served = hubEnvelopeMarks(result);
        log.error('XChain SDK HubConnector: HUB CONFIG REGRESSION: ' + url + ' served seq ' +
                      served.seq + '/watermark ' + served.watermark + ', below last-seen ' +
                      connector.lastSeq + '/' + connector.lastWatermark +
                      ' (hub restart or restore from an older snapshot); discarding cached config and re-fetching the full tree.');
        connector.lastWatermark = 0;
        connector.configs       = null;
        result = await connector.postGetAllConfigs(url, 0, headers);
        if (result === undefined) return undefined;
        if (isHubErrorEnvelope(result)) throw new Error('hub returned error result: ' + result.error);
    }
    return result;
}

module.exports = {
    // Fetch all configs from the hub via JSON-RPC (tries each endpoint in order)
    async getAllConfig() {
        let lastError = null;
        let headers = {};
        if (this.apiKey) headers['x-api-key'] = this.apiKey;
        for(let i = 0; i < this.urls.length; i++){
            let idx = (this._lastGoodIdx + i) % this.urls.length;
            let url = this.urls[idx];
            // The cursor is only valid against the endpoint that produced it (see
            // _watermarkEndpointIdx): any other candidate is asked for the full tree.
            let cursorValid = this.lastWatermark > 0 && this._watermarkEndpointIdx === idx;
            // Re-request the boundary second (cursor - 1), not the watermark itself. The
            // hub's cursor compares UNIX_TIMESTAMP(updated_at) >= ? in WHOLE seconds
            // (inclusive since item #2265), and its watermark is MAX(updated_at) in whole
            // seconds, so a row upserted in the watermark's second W after the hub read
            // MAX(updated_at) = W is re-delivered on the next poll. An older hub compared
            // `> W` and would strand that row forever (the SDK would serve the stale value
            // until restart), so keep the one-second overlap as deployment-skew protection;
            // do not "simplify" the - 1 away. mergeConfigDelta is an idempotent upsert
            // (the configs table is never deleted from), so re-merging a row we already
            // have is a no-op; the cost is one second of rows per poll.
            let sinceCursor = cursorValid ? Math.max(0, this.lastWatermark - 1) : 0;
            try {
                let result = await fetchConfigResult(this, url, cursorValid, sinceCursor, headers);
                if (result === undefined) continue;
                this._lastGoodIdx = idx;
                this.configs = this.applyConfigResult(result);
                // Bind the (possibly advanced) cursor to the endpoint that answered.
                this._watermarkEndpointIdx = idx;
                this.lastFetch = Date.now();
                return this.configs;
            } catch (err) {
                lastError = err;
            }
        }

        throw new SDKHubError(
            'HUB_UNAVAILABLE',
            'Failed to fetch config from hub (tried ' + this.urls.length + ' endpoint(s)): ' + (lastError ? lastError.message : 'no result'),
            { urls: this.urls, error: lastError ? lastError.message : 'no result' }
        );
    },

    // POST one getallconfigs call with the given cursor and return the JSON-RPC
    // result member (undefined when the response carries none; throws on transport
    // failure so the failover loop records it).
    async postGetAllConfigs(url, sinceCursor, headers) {
        let payload = {
            jsonrpc: '2.0',
            method:  'getallconfigs',
            // Echo the high-water mark so the hub returns only rows changed since
            // our last poll; 0 requests the full tree (initial fetch / old hub).
            params:  { since_updated_at: sinceCursor },
            id:      1
        };
        let response = await axios.post(url, payload, { timeout: this.timeout, headers, ...agentOptsFor(url, this._pool) });
        if (response.data && response.data.result) return response.data.result;
        return undefined;
    },

    // True when a watermarked envelope from the cursor's own endpoint reports a
    // seq or watermark BELOW the last one it served us (hub restart / restore
    // from an older snapshot). A missing watermark is the full tree (handled by
    // applyConfigResult) and a zero watermark means an empty configs table, so
    // neither counts; the next poll re-fetches in full either way.
    hubConfigRegressed(result) {
        let marks = hubEnvelopeMarks(result);
        if (marks.watermark === null) return false;
        return (marks.watermark > 0 && marks.watermark < this.lastWatermark) ||
               (this.lastSeq > 0 && marks.seq < this.lastSeq);
    },

    // Fold a getallconfigs result into this.configs and return the full nested
    // map. Newer hubs wrap the payload as { configs, seq, watermark }: when a
    // watermark is present the payload is a delta (only rows changed since the
    // cursor we sent), so we MERGE it into the cache and advance the cursor.
    // Older hubs return the bare map (or a { configs, seq } wrapper without a
    // watermark): those are always the full tree, so we REPLACE. Callers
    // (extractServiceEndpoints) see the same full-map shape regardless of hub
    // version. seq stays 0 against an old hub.
    applyConfigResult(result) {
        this.checkHubConsensusHash(result && typeof result === 'object' ? result.coin_consensus_hashes : null);

        let payload, seq, watermark;
        if (result && typeof result === 'object' && result.configs && typeof result.configs === 'object' && ('seq' in result)) {
            payload   = result.configs;
            seq       = Number(result.seq) || 0;
            watermark = ('watermark' in result) ? result.watermark : undefined;
        } else {
            payload   = result;
            seq       = 0;
            watermark = undefined;
        }
        this.lastSeq = seq;

        if (watermark === undefined || watermark === null) {
            // Hub doesn't report a watermark. Payload is the full tree. Reset the
            // cursor so the next poll also requests in full.
            this.lastWatermark = 0;
            return payload || {};
        }

        let sentCursor = this.lastWatermark > 0;
        this.lastWatermark = Number(watermark) || 0;

        if (sentCursor && this.configs) {
            // Delta against the cursor we sent: merge changed rows into the cache.
            return mergeConfigDelta(this.configs, payload || {});
        }
        // First fetch (or post-restart): payload is the full tree.
        return payload || {};
    },

    // Transport-integrity check: compare the consensus-config hashes the hub serves
    // on getallconfigs against our OWN bundled ones. Hub-served consensus values are
    // never applied (the SDK derives them from the bundled src/coins registry, which
    // is itself pin-verified), so this only logs; what it buys is that a hub built
    // from a divergent bundle surfaces at the first config fetch instead of later as
    // an opaque refused-or-wrong encode. Widened to every coin and network because
    // the SDK bundles all three and is pointed at whatever venue the caller chose.
    checkHubConsensusHash(hubHashes){
        if(!hubHashes || typeof hubHashes !== 'object') return;   // older hub: field absent
        let mismatches = [];
        for(const network of coins.NETWORKS){
            let served = hubHashes[network];
            if(!served || typeof served !== 'object') continue;
            let local = localConsensusHashes(network);
            for(const tick of Object.keys(local)){
                // A coin the hub does not serve is version skew, not drift; only a
                // hash the hub DOES serve and that differs counts as a mismatch.
                if(served[tick] && served[tick] !== local[tick])
                    mismatches.push(tick + '/' + network + ': hub ' + served[tick] + ' vs bundled ' + local[tick]);
            }
        }
        // A polling SDK re-runs this on every fetch, so log only when the mismatch
        // SET changes: a standing divergence must not flood the console, and a drift
        // that widens or clears must still report.
        let key = mismatches.join('|');
        if(key === (this._lastConsensusMismatchKey || '')) return;
        this._lastConsensusMismatchKey = key;
        if(mismatches.length)
            log.error('XChain SDK HubConnector: CONSENSUS HASH MISMATCH: the hub serves consensus config differing from this package\'s bundled coin files (' +
                mismatches.join('; ') + '). Hub consensus values are never applied (they are pinned locally); upgrade the lagging side.');
    }
};
