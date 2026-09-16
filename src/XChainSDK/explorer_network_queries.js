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
 * XChain Platform SDK - XChainSDK (Software Development Kit)
 *
 * This file handles parsing XChain Platform SDK requests
 *
 ********************************************************************/

const CheckpointVerifier = require('../checkpoint.js');
const { SDKExplorerError } = require('../utils/errors.js');

// Keep network queries together so explorer-wide state reads stay easy to compare.
module.exports = {


    /*
     *  Explorer: Staking Methods
     */

    async getStakes(query, type, opts) {
        return this.requireExplorer().getStakes(query, type, opts);
    },

    async getUnstakes(query, type, opts) {
        return this.requireExplorer().getUnstakes(query, type, opts);
    },

    async getStakeKeyRevocations(query, type, opts) {
        return this.requireExplorer().getStakeKeyRevocations(query, type, opts);
    },

    async getCollects(query, type, opts) {
        return this.requireExplorer().getCollects(query, type, opts);
    },

    async getDelegations(query, type, opts) {
        return this.requireExplorer().getDelegations(query, type, opts);
    },

    async getValidators(opts) {
        return this.requireExplorer().getValidators(opts);
    },

    async getValidatorRewards(query, type, opts) {
        return this.requireExplorer().getValidatorRewards(query, type, opts);
    },

    async getContractStakes(query, type, opts) {
        return this.requireExplorer().getContractStakes(query, type, opts);
    },

    async getContractUnstakes(query, type, opts) {
        return this.requireExplorer().getContractUnstakes(query, type, opts);
    },

    async getContractDelegations(query, type, opts) {
        return this.requireExplorer().getContractDelegations(query, type, opts);
    },

    async getSlashEvents(query, type, opts) {
        return this.requireExplorer().getSlashEvents(query, type, opts);
    },

    async getCapabilitySlashEvents(query, type, opts) {
        return this.requireExplorer().getCapabilitySlashEvents(query, type, opts);
    },

    async getControllers(opts) {
        return this.requireExplorer().getControllers(opts);
    },

    async getDeployChunks(opts) {
        return this.requireExplorer().getDeployChunks(opts);
    },

    async getFullNodeVerifications(query, type, opts) {
        return this.requireExplorer().getFullNodeVerifications(query, type, opts);
    },

    async getCrossChainMatches(query, type, opts) {
        return this.requireExplorer().getCrossChainMatches(query, type, opts);
    },

    async getCrossChainSettlements(query, type, opts) {
        return this.requireExplorer().getCrossChainSettlements(query, type, opts);
    },

    async getAnchors(query, type, opts) {
        return this.requireExplorer().getAnchors(query, type, opts);
    },

    async getOraclePrices(query, type, opts) {
        return this.requireExplorer().getOraclePrices(query, type, opts);
    },

    async getValidatorCapabilities(query, type, opts) {
        return this.requireExplorer().getValidatorCapabilities(query, type, opts);
    },

    async getGovernanceProposals(query, type, opts) {
        return this.requireExplorer().getGovernanceProposals(query, type, opts);
    },

    async getGovernanceVotes(query, type, opts) {
        return this.requireExplorer().getGovernanceVotes(query, type, opts);
    },

    async getPolls(query, type, opts) {
        return this.requireExplorer().getPolls(query, type, opts);
    },

    // BET reads (§11.1). These proxies were missing while explorer.js already
    // carried all four methods, and the gap was invisible to both sides' unit
    // tests: the SDK suite exercises the ExplorerClient directly, and consumers
    // mock the SDK, so a mock always has whatever the test defines. The result was
    // that every betting read in the wallet threw "sdk.getBetFeeds is unavailable"
    // at runtime, which only surfaced when the market browser was driven against a
    // real stack.
    async getBetFeeds(query, type, opts) {
        return this.requireExplorer().getBetFeeds(query, type, opts);
    },

    async getBetFeed(feedIndex, opts) {
        return this.requireExplorer().getBetFeed(feedIndex, opts);
    },

    async getBets(query, type, opts) {
        return this.requireExplorer().getBets(query, type, opts);
    },

    async getOracleStats(address, opts) {
        return this.requireExplorer().getOracleStats(address, opts);
    },

    async getPoll(pollIndex, opts) {
        return this.requireExplorer().getPoll(pollIndex, opts);
    },

    async getPollResults(pollIndex, opts) {
        return this.requireExplorer().getPollResults(pollIndex, opts);
    },

    async getVotes(query, type, opts) {
        return this.requireExplorer().getVotes(query, type, opts);
    },

    /*
     *  Explorer: Light-client (SPV) checkpoint + proof methods
     */

    async getCheckpoints(opts) {
        return this.requireExplorer().getCheckpoints(opts);
    },

    async getCheckpointRange(from, to, opts) {
        return this.requireExplorer().getCheckpointRange(from, to, opts);
    },

    async getCheckpointVerify(blockIndex) {
        return this.requireExplorer().getCheckpointVerify(blockIndex);
    },

    async getBalanceProof(address, tick, opts) {
        return this.requireExplorer().getBalanceProof(address, tick, opts);
    },

    async getActionProof(actionIndex) {
        return this.requireExplorer().getActionProof(actionIndex);
    },

    async getValidatorSetProof(opts) {
        return this.requireExplorer().getValidatorSetProof(opts);
    },

    async getContractStateProof(contractIndex, key) {
        return this.requireExplorer().getContractStateProof(contractIndex, key);
    },

    // Fetch the checkpoint at blockIndex through the pooled, retry-aware
    // ExplorerClient (vs sdk.checkpoint.fetchAndVerifyCheckpoint's bare fetch),
    // then re-verify it LOCALLY with Ed25519. The server's `verified` flag is
    // ignored; only local crypto decides.
    async verifyCheckpoint(blockIndex) {
        let body = await this.requireExplorer().getCheckpointVerify(blockIndex);
        // Nothing to verify if the explorer sent no checkpoint back; fail loudly rather than report success.
        if (!body || !body.checkpoint) throw new Error('verifyCheckpoint: no checkpoint in response');
        let result = CheckpointVerifier.verifyCheckpoint(body.checkpoint, body.validators || []);
        return Object.assign({ checkpoint: body.checkpoint, snapshotAvailable: !!body.snapshot_available }, result);
    },


    /*
     *  Explorer: Market Methods
     */

    async getMarkets(tick) {
        return this.requireExplorer().getMarkets(tick);
    },

    async getMarket(tick1, tick2) {
        return this.requireExplorer().getMarket(tick1, tick2);
    },

    async getMarketHistory(tick1, tick2, address, opts) {
        return this.requireExplorer().getMarketHistory(tick1, tick2, address, opts);
    },

    async getMarketOrders(tick1, tick2, address, opts) {
        return this.requireExplorer().getMarketOrders(tick1, tick2, address, opts);
    },

    async getOrderbook(tick1, tick2) {
        return this.requireExplorer().getOrderbook(tick1, tick2);
    },

    async getPrices(query, type, opts) {
        return this.requireExplorer().getPrices(query, type, opts);
    },

    async getPriceSnapshots(query, type, opts) {
        return this.requireExplorer().getPriceSnapshots(query, type, opts);
    },


    /*
     *  Explorer: Utility Methods
     */

    // Indexer status: per-coin last_block / last_block_time (indexer position),
    // plus decoder_tip (the decoder's highest *processed* block) and
    // decoder_lag_blocks (decoder_tip - last_block, >= 0) so a stalled indexer is
    // detectable from this single call. This covers the indexer->decoder slice only,
    // NOT whole-pipeline lag: the coin node's chain tip is not exposed here (use the
    // decoder's health() RPC for the chain->decoder gap). decoder_tip /
    // decoder_lag_blocks are null for a coin when the decoder tip is unavailable. See
    // ExplorerClient.getStatus for the full field list.
    async getStatus() {
        return this.requireExplorer().getStatus();
    },

    // Freshness of the explorer's indexed tip for this SDK's coin, as the
    // explorer stamped it on the last data response this client received:
    // { stale, tipBlock, tipAgeSeconds, replicaHalted, observedAt }, or null
    // before any marked response has arrived. The explorer serves a coin whose
    // tip is behind rather than refusing the read, so a read succeeding says
    // nothing about how current it is; this does. Read it after a balance or
    // history call, or call assertFresh() on a path that must not build on
    // stale state.
    freshness() {
        return this.requireExplorer().freshness();
    },

    // Resolve the freshness of this SDK's coin, probing /status when no marked
    // response has been seen yet (or the last one is older than maxAgeMs), and
    // throw SDKExplorerError COIN_DATA_STALE when the tip is stale. Returns the
    // freshness record when it is live. A coin the explorer does not measure
    // (no `stale` entry for it) passes: there is no verdict to fail on. The
    // /status probe also makes this work against an explorer that predates the
    // per-response markers, since `stale` has been on /status longer.
    async assertFresh(opts = {}) {
        let explorer = this.requireExplorer();
        let maxAgeMs = Number.isFinite(Number(opts.maxAgeMs)) ? Number(opts.maxAgeMs) : 60000;
        let f = explorer.freshness();
        if (!f || (Date.now() - f.observedAt) >= maxAgeMs) {
            let status = await explorer.getStatus();
            let coin   = explorer.coin;
            let stale  = status && status.stale && typeof status.stale === 'object' ? status.stale[coin] : undefined;
            let num    = (v) => (v === undefined || v === null || !Number.isFinite(Number(v))) ? null : Number(v);
            if (stale === undefined) return { stale: false, tipBlock: null, tipAgeSeconds: null, replicaHalted: null, observedAt: Date.now(), measured: false };
            f = {
                stale:         stale === true,
                tipBlock:      status.last_block      ? num(status.last_block[coin])      : null,
                tipAgeSeconds: status.tip_age_seconds ? num(status.tip_age_seconds[coin]) : null,
                replicaHalted: status.replica_halted && typeof status.replica_halted[coin] === 'boolean' ? status.replica_halted[coin] : null,
                observedAt:    Date.now()
            };
        }
        if (f.stale) {
            let where = f.tipBlock !== null ? ' at block ' + f.tipBlock : '';
            let age   = f.tipAgeSeconds !== null ? ' (' + Math.round(f.tipAgeSeconds / 60) + ' minutes old)' : '';
            throw new SDKExplorerError('COIN_DATA_STALE',
                'Explorer data for ' + explorer.coin + ' is behind the chain' + where + age + '; refusing to build on it',
                { freshness: f });
        }
        return f;
    },

    // Unconfirmed mempool actions, type ∈ {address, token}.
    async getMempool(query, type, opts) {
        return this.requireExplorer().getMempool(query, type, opts);
    },

    // The unconfirmed transactions involving ONE address: the address-typed,
    // wallet-facing read over the same /mempool/{query}/{type} route getMempool
    // wraps. Returns a plain ARRAY of rows (never null, never a throw on an empty
    // mempool), each:
    //
    //   { tx_hash, source, action, data, first_seen, destinations: string[] }
    //
    // Field names are the explorer's, VERBATIM, and are not camelCased on the way
    // through: mempool rows, confirmed history rows and the wallet's own pending
    // records are merged by the same keys downstream, and one renaming layer in
    // the middle is how those three vocabularies drift apart.
    //
    // `first_seen` is UNIX SECONDS (not milliseconds) and is null against a
    // decoder DB predating the first_seen migration, so a caller that needs a
    // timestamp must have a fallback.
    //
    // `destinations` is additive, and here it can only ever hold the queried
    // address: this is a REST read with no subscriber set behind it, so the one
    // party the server attested to is the address that was asked about. The
    // semantics match the WS frame's field exactly (matched parties, source
    // excluded), which is what lets a caller derive direction the same way from a
    // polled row and a live frame. It is empty when the row is the address's OWN
    // transaction, i.e. `source` is the address.
    //
    // Deliberately NO `amounts` field: only SEND v0-v3 has a documented output
    // layout, so per-output tuples cannot be produced honestly for every action
    // and a partially-populated field would read as authoritative.
    //
    // WINDOW: the explorer prefilters a bounded 500-row window of the mempool
    // (ordered by tx_hash, not by time), so on a busy chain an address's pending
    // transaction can sit outside it and this returns []. Absence is not proof a
    // transaction was dropped.
    async getUnconfirmed(address, opts) {
        // 100 matches the SDK's own existing mempool caller (x402's payment
        // verifier) and sits well inside the explorer's 500-row window.
        const options = Object.assign({ limit: 100 }, opts || {});
        const res  = await this.requireExplorer().getMempool(address, 'address', options);
        const rows = (res && Array.isArray(res.data)) ? res.data : [];
        return rows.map((row) => ({
            tx_hash:    row.tx_hash    === undefined ? null : row.tx_hash,
            source:     row.source     === undefined ? null : row.source,
            action:     row.action     === undefined ? null : row.action,
            data:       row.data       === undefined ? null : row.data,
            first_seen: row.first_seen === undefined ? null : row.first_seen,
            // Compared exactly, with no case folding, because the server matched
            // it that way: normalizing here would claim a match the explorer's
            // own prefilter did not make.
            destinations: (row.source === address) ? [] : [address]
        }));
    },

    // Network-wide summary (chain heights, indexer status, peer counts,
    // recommended finality confirmations). See ExplorerClient.getNetwork.
    async getNetwork(opts) {
        return this.requireExplorer().getNetwork(opts);
    },

    async search(query, type) {
        return this.requireExplorer().search(query, type);
    },
};
