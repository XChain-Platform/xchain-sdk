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
 * XChain Platform SDK - Explorer Client
 *
 * HTTP client wrapping the xchain-explorer REST API endpoints
 *
 ********************************************************************/

const { SDKExplorerError } = require('../../utils/errors.js');
const { withRetry, isRetryable } = require('../../utils/retry.js');

module.exports = {
    /*
     *  Staking Methods
     */

    async getStakes(query, type, opts = {}) {
        if (query)
            return this.get('/stakes/' + query + '/' + type, opts);
        return this.get('/stakes', opts);
    },

    // Capability unstakes (UNSTAKE v0; begins the global cooldown on a staked key),
    // type ∈ {block, address, source}. Contract-targeted unstakes are getContractUnstakes.
    async getUnstakes(query, type, opts = {}) {
        if (query)
            return this.get('/unstakes/' + query + '/' + type, opts);
        return this.get('/unstakes', opts);
    },

    // Signing-key revocations (DELEGATE v2/v3), type ∈ {block, address, source}.
    async getStakeKeyRevocations(query, type, opts = {}) {
        if (query)
            return this.get('/delegation_revocations/' + query + '/' + type, opts);
        return this.get('/delegation_revocations', opts);
    },

    // Validator reward claims (COLLECT; the reward_claims table), type ∈ {block, address, source}.
    // The per-reward-type accrual ledger is getValidatorRewards; this is the claim event.
    async getCollects(query, type, opts = {}) {
        if (query)
            return this.get('/collects/' + query + '/' + type, opts);
        return this.get('/collects', opts);
    },

    async getDelegations(query, type, opts = {}) {
        return this.get('/delegations/' + query + '/' + type, opts);
    },

    async getValidators(opts = {}) {
        return this.get('/validators', opts);
    },

    async getValidatorRewards(query, type, opts = {}) {
        return this.get('/rewards/' + query + '/' + type, opts);
    },

    // Contract-targeted stakes (STAKE v3), type ∈ {address, block, contract}.
    async getContractStakes(query, type, opts = {}) {
        if (query)
            return this.get('/contract_stakes/' + query + '/' + type, opts);
        return this.get('/contract_stakes', opts);
    },

    // Contract-targeted unstakes (UNSTAKE v1), type ∈ {address, block, contract}.
    async getContractUnstakes(query, type, opts = {}) {
        if (query)
            return this.get('/contract_unstakes/' + query + '/' + type, opts);
        return this.get('/contract_unstakes', opts);
    },

    // Contract-targeted delegations (DELEGATE v1), type ∈ {block, address, contract}.
    async getContractDelegations(query, type, opts = {}) {
        if (query)
            return this.get('/contract_delegations/' + query + '/' + type, opts);
        return this.get('/contract_delegations', opts);
    },

    // External Attestation Framework rows (ATTEST v0 requests + v1/v2
    // responses from the `attests` table), type ∈ {address, block, contract}.
    async getAttestations(query, type, opts = {}) {
        if (query)
            return this.get('/attestations/' + query + '/' + type, opts);
        return this.get('/attestations', opts);
    },

    // Slash events emitted by contracts via xchain.contract.slash,
    // type ∈ {address, block, contract}.
    async getSlashEvents(query, type, opts = {}) {
        if (query)
            return this.get('/slash_events/' + query + '/' + type, opts);
        return this.get('/slash_events', opts);
    },

    // Capability equivocation slashes (SLASH wire action; capability_slash_events),
    // type ∈ {block, capability, pubkey, address}. Distinct from getSlashEvents, which
    // lists contract-emitted slashes (xchain.contract.slash).
    async getCapabilitySlashEvents(query, type, opts = {}) {
        if (query)
            return this.get('/capability_slash_events/' + query + '/' + type, opts);
        return this.get('/capability_slash_events', opts);
    },

    // XCALL cross-chain calls (VM-emitted via xchain.emit.crossExecute; read-only).
    // List the source-chain request rows, type ∈ {block, contract, status}.
    async getXcalls(query, type, opts = {}) {
        if (query)
            return this.get('/xcalls/' + query + '/' + type, opts);
        return this.get('/xcalls', opts);
    },

    // Full lifecycle for one cross-chain call by call_id: the source request plus the
    // target-chain execution outcome and the source-chain callback delivery (each null
    // until the call is relayed/executed/delivered).
    async getXcall(callId) {
        return this.get('/xcall/' + callId);
    },

    // Controller-bound token policy rows (programmable policy layer; read-only, no query).
    async getControllers(opts = {}) {
        return this.get('/controllers', opts);
    },

    // DEPLOY v4 carrier chunks (chunked-DEPLOY reassembly; read-only, no query).
    async getDeployChunks(opts = {}) {
        return this.get('/deploy_chunks', opts);
    },

    // Full-node possession-proof verdicts (NODEPROOF v0), type ∈ {block, epoch, pubkey, address}.
    async getFullNodeVerifications(query, type, opts = {}) {
        if (query)
            return this.get('/full_node_verifications/' + query + '/' + type, opts);
        return this.get('/full_node_verifications', opts);
    },

    // Cross-chain settlement match rows (XCALL/DEX mirrors), type ∈ {match, block, status}.
    async getCrossChainMatches(query, type, opts = {}) {
        if (query)
            return this.get('/cross_chain_matches/' + query + '/' + type, opts);
        return this.get('/cross_chain_matches', opts);
    },

    // Cross-chain settlement rows (the settle leg of a match), type ∈ {match, block}.
    async getCrossChainSettlements(query, type, opts = {}) {
        if (query)
            return this.get('/cross_chain_settlements/' + query + '/' + type, opts);
        return this.get('/cross_chain_settlements', opts);
    },

    // ANCHOR checkpoint-anchor rows, type ∈ {block, chain, network, status}.
    async getAnchors(query, type, opts = {}) {
        if (query)
            return this.get('/anchors/' + query + '/' + type, opts);
        return this.get('/anchors', opts);
    },

    // User-published token/fiat oracle prices (PRICE v1; hub-mirrored oracle_prices),
    // type ∈ {token, address}. The validator COIN/FIAT snapshots are getPriceSnapshots.
    async getOraclePrices(query, type, opts = {}) {
        if (query)
            return this.get('/oracle_prices/' + query + '/' + type, opts);
        return this.get('/oracle_prices', opts);
    },

    // Per-validator per-capability qualification flags (hub-owned validator_capabilities,
    // read from the explorer's co-located hub DB), type ∈ {capability, pubkey}.
    async getValidatorCapabilities(query, type, opts = {}) {
        if (query)
            return this.get('/validator_capabilities/' + query + '/' + type, opts);
        return this.get('/validator_capabilities', opts);
    },

    // Federation governance parameter proposals (hub-owned governance_proposals),
    // type ∈ {status, parameter, proposal}.
    async getGovernanceProposals(query, type, opts = {}) {
        if (query)
            return this.get('/governance_proposals/' + query + '/' + type, opts);
        return this.get('/governance_proposals', opts);
    },

    // Per-validator governance votes (hub-owned governance_votes), type ∈ {proposal, voter}.
    async getGovernanceVotes(query, type, opts = {}) {
        if (query)
            return this.get('/governance_votes/' + query + '/' + type, opts);
        return this.get('/governance_votes', opts);
    },

    // Token-weighted governance polls (VOTE v0; polls table), type ∈ {block, tick, status, source}.
    // Distinct from getGovernanceVotes/getGovernanceProposals, which are the hub federation's
    // parameter-change governance. tick = the electorate/weight token; status = the poll
    // lifecycle (open/finalized/failed_quorum); source = the poll creator.
    async getPolls(query, type, opts = {}) {
        if (query)
            return this.get('/polls/' + query + '/' + type, opts);
        return this.get('/polls', opts);
    },

    // A single VOTE poll by its id (the creating action_index). Returns the full poll
    // definition + finalization summary, with options/callback_params JSON-parsed.
    async getPoll(pollIndex, opts = {}) {
        return this.get('/poll/' + pollIndex, opts);
    },

    // The frozen per-option tally for one poll (poll_results, written by VOTE v2 finalize).
    // Empty until the poll is finalized; ordered by option_index.
    async getPollResults(pollIndex, opts = {}) {
        return this.get('/poll/' + pollIndex + '/results', opts);
    },

    // VOTE ballots (v1; votes table), one row per (poll, voter, chosen option),
    // type ∈ {address, poll, block}. The voter is the ballot's source address.
    async getVotes(query, type, opts = {}) {
        if (query)
            return this.get('/votes/' + query + '/' + type, opts);
        return this.get('/votes', opts);
    },

    /*
     *  Light-client (SPV) checkpoint + proof methods
     *  The typed, pooled, retry-aware path to the explorer's state-checkpoint
     *  verification surface (SPV spec §4/§5/§7/§8).
     */

    // Latest quorum-signed state checkpoints for this coin's chain. opts.limit caps the list.
    async getCheckpoints(opts = {}) {
        return this.get('/checkpoints', opts);
    },

    // Forward-following checkpoint range [from, to] (SPV §8.1). from/to are block heights.
    async getCheckpointRange(from, to, opts = {}) {
        return this.get('/checkpoints/range', Object.assign({ from, to }, opts));
    },

    // Re-fetch the checkpoint at blockIndex with its validator set for LOCAL re-verification.
    async getCheckpointVerify(blockIndex) {
        return this.get('/checkpoint/' + blockIndex + '/verify');
    },

    // Merkle inclusion proof for an address/tick balance against stakes/ledger root
    // (SPV §4.4). opts.height pins the checkpoint snapshot height.
    async getBalanceProof(address, tick, opts = {}) {
        return this.get('/proof/balance/' + address + '/' + tick, opts);
    },

    // Merkle inclusion proof for an action by index (SPV §5).
    async getActionProof(actionIndex) {
        return this.get('/proof/action/' + actionIndex);
    },

    // Validator-set (stakes_root) proof (SPV §7.2; BTC-only). opts.height pins the snapshot.
    async getValidatorSetProof(opts = {}) {
        return this.get('/proof/validator-set', opts);
    },

    // Contract-state inclusion proof for (contractIndex, key) (SPV §8.1).
    async getContractStateProof(contractIndex, key) {
        return this.get('/proof/contract-state/' + contractIndex + '/' + key);
    },


    /*
     *  Market Methods
     */

    async getMarkets(tick) {
        if (tick)
            return this.get('/markets/' + tick);
        return this.get('/markets');
    },

    async getMarket(tick1, tick2) {
        return this.get('/market/' + tick1 + '/' + tick2);
    },

    async getMarketHistory(tick1, tick2, address, opts = {}) {
        if (address)
            return this.get('/market/' + tick1 + '/' + tick2 + '/history/' + address, opts);
        return this.get('/market/' + tick1 + '/' + tick2 + '/history', opts);
    },

    async getMarketOrders(tick1, tick2, address, opts = {}) {
        if (address)
            return this.get('/market/' + tick1 + '/' + tick2 + '/orders/' + address, opts);
        return this.get('/market/' + tick1 + '/' + tick2 + '/orders', opts);
    },

    async getOrderbook(tick1, tick2) {
        return this.get('/market/' + tick1 + '/' + tick2 + '/orderbook');
    },


    /*
     *  Utility Methods
     */

    // Indexer status. Returns per-coin maps:
    //   supported / available: configured and currently-served coins
    //   last_block[coin]:       highest block the indexer has processed
    //   last_block_time[coin]:  block_time of that block
    //   decoder_tip[coin]:      the decoder's highest *processed* block, or null
    //                            if unavailable. NOT the coin node's chain tip (see
    //                            the decoder's health() RPC for the chain->decoder gap).
    //   decoder_lag_blocks[coin]: decoder_tip - last_block (>= 0), or null when
    //                            decoder_tip is null. Lets a caller detect a stalled
    //                            indexer (indexer->decoder slice) from this single
    //                            call rather than a separate tip query.
    async getStatus() {
        return this.get('/status');
    },

    // Unconfirmed mempool actions, type ∈ {address, token}.
    async getMempool(query, type, opts = {}) {
        return this.get('/mempool/' + query + '/' + type, opts);
    },

    // Network-wide summary (chain heights, indexer status, peer counts). Also
    // includes a `finality` map ({ BTC, LTC, DOGE }): the recommended number of
    // confirmations to wait before treating a same-chain receipt as final
    // (display/UX guidance; the indexer itself processes actions at the tip).
    async getNetwork(opts = {}) {
        return this.get('/network', opts);
    },

    async search(query, type) {
        // Search uses the /explorer/ path instead of /api/
        let url = '/' + this.coin + '/explorer/search/' + query + '/' + type;
        let self = this;

        let retryConfig = this.retry === false ? { maxRetries: 0 } : this.retry;

        try {
            return await withRetry(async () => {
                if (self.hooks.onRequest)
                    self.hooks.onRequest({ service: 'explorer', method: 'GET', url });
                try {
                    let response = await self.client.get(url);
                    if (self.hooks.onResponse)
                        self.hooks.onResponse({ service: 'explorer', method: 'GET', url, status: response.status });
                    return response.data;
                } catch (err) {
                    if (self.hooks.onError)
                        self.hooks.onError({ service: 'explorer', method: 'GET', url, error: err.message });
                    if (isRetryable(err)) throw err;
                    self.handleError(err, url);
                }
            }, retryConfig, null);
        } catch (err) {
            if (err instanceof SDKExplorerError) throw err;
            self.handleError(err, url);
        }
    },
};
