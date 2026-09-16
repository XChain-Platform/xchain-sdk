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


// Keep ledger queries together so explorer table reads stay easy to compare.
module.exports = {


    /*
     *  Explorer: Balance & Address Methods
     */

    async getBalances(address, opts) {
        return this.requireExplorer().getBalances(address, opts);
    },

    // Up to 20 addresses in one request, answered keyed by address. A caller
    // that must also work against an older explorer feature-detects with
    // `typeof sdk.getBalancesBatch === 'function'` and falls back on a 404.
    async getBalancesBatch(addresses, opts) {
        return this.requireExplorer().getBalancesBatch(addresses, opts);
    },

    async getAddress(address) {
        return this.requireExplorer().getAddress(address);
    },

    async getHolders(tick, opts) {
        return this.requireExplorer().getHolders(tick, opts);
    },

    async getCredits(query, type, opts) {
        return this.requireExplorer().getCredits(query, type, opts);
    },

    async getDebits(query, type, opts) {
        return this.requireExplorer().getDebits(query, type, opts);
    },

    async getEscrows(query, type, opts) {
        return this.requireExplorer().getEscrows(query, type, opts);
    },


    /*
     *  Explorer: Token Methods
     */

    // Raw token read: answers the NESTED envelope { info: { tick, tick_id, ... } }
    // and THROWS SDKExplorerError EXPLORER_HTTP_404 when the tick does not
    // exist. For an existence check use tokenExists/findToken below.
    async getToken(tick, opts) {
        return this.requireExplorer().getToken(tick, opts);
    },

    // The token's info record (already unwrapped from the .info envelope), or
    // null when the tick does not exist. Errors other than the 404 still throw.
    async findToken(tick, opts) {
        return this.requireExplorer().findToken(tick, opts);
    },

    // true/false existence check that does not throw on a missing tick.
    async tokenExists(tick, opts) {
        return this.requireExplorer().tokenExists(tick, opts);
    },

    // Current official-token roster of a project tick (protocol/Project_Registry.md)
    async getProject(tick) {
        return this.requireExplorer().getProject(tick);
    },

    async getTokens(query, type, opts) {
        return this.requireExplorer().getTokens(query, type, opts);
    },

    async getIssues(query, type, opts) {
        return this.requireExplorer().getIssues(query, type, opts);
    },


    /*
     *  Explorer: Transaction & History Methods
     */

    async getTransaction(query, type) {
        return this.requireExplorer().getTransaction(query, type);
    },

    async getAction(actionIndex) {
        return this.requireExplorer().getAction(actionIndex);
    },

    async getBlock(blockIndex) {
        return this.requireExplorer().getBlock(blockIndex);
    },

    async getHistory(query, type, opts) {
        return this.requireExplorer().getHistory(query, type, opts);
    },


    /*
     *  Explorer: ACTION-Specific Query Methods
     */

    async getAddresses(query, type, opts) {
        return this.requireExplorer().getAddresses(query, type, opts);
    },

    async getAirdrops(query, type, opts) {
        return this.requireExplorer().getAirdrops(query, type, opts);
    },

    async getBatches(query, type, opts) {
        return this.requireExplorer().getBatches(query, type, opts);
    },

    async getBroadcasts(query, type, opts) {
        return this.requireExplorer().getBroadcasts(query, type, opts);
    },

    async getCallbacks(query, type, opts) {
        return this.requireExplorer().getCallbacks(query, type, opts);
    },

    async getDestroys(query, type, opts) {
        return this.requireExplorer().getDestroys(query, type, opts);
    },

    async getCoinpays(query, type, opts) {
        return this.requireExplorer().getCoinpays(query, type, opts);
    },

    async getCoinpayExpires(query, type, opts) {
        return this.requireExplorer().getCoinpayExpires(query, type, opts);
    },

    async getCoinpayObligations(query, type, opts) {
        return this.requireExplorer().getCoinpayObligations(query, type, opts);
    },

    // The address-typed obligations read for up to 20 addresses in one request,
    // answered keyed by address.
    async getCoinpayObligationsBatch(addresses, opts) {
        return this.requireExplorer().getCoinpayObligationsBatch(addresses, opts);
    },

    async getDispensers(query, type, opts) {
        return this.requireExplorer().getDispensers(query, type, opts);
    },

    async getDispenses(query, type, opts) {
        return this.requireExplorer().getDispenses(query, type, opts);
    },

    // Dispenser lifecycle events (cancellations), type ∈ {block, address}.
    async getDispenserCancels(query, type, opts) {
        return this.requireExplorer().getDispenserCancels(query, type, opts);
    },

    async getDispenserCloses(query, type, opts) {
        return this.requireExplorer().getDispenserCloses(query, type, opts);
    },

    async getDispenserExpires(query, type, opts) {
        return this.requireExplorer().getDispenserExpires(query, type, opts);
    },

    async getDispenserEdits(query, type, opts) {
        return this.requireExplorer().getDispenserEdits(query, type, opts);
    },

    async getDividends(query, type, opts) {
        return this.requireExplorer().getDividends(query, type, opts);
    },

    async getFees(query, type, opts) {
        return this.requireExplorer().getFees(query, type, opts);
    },

    async getFiles(query, type, opts) {
        return this.requireExplorer().getFiles(query, type, opts);
    },

    async getLinks(query, type, opts) {
        return this.requireExplorer().getLinks(query, type, opts);
    },

    async getLists(query, type, opts) {
        return this.requireExplorer().getLists(query, type, opts);
    },

    async getMessages(query, type, opts) {
        return this.requireExplorer().getMessages(query, type, opts);
    },

    async getMints(query, type, opts) {
        return this.requireExplorer().getMints(query, type, opts);
    },

    async getOrders(query, type, opts) {
        return this.requireExplorer().getOrders(query, type, opts);
    },

    // Order lifecycle events (cancellations), type ∈ {block, address}.
    async getOrderCancels(query, type, opts) {
        return this.requireExplorer().getOrderCancels(query, type, opts);
    },

    async getOrderEdits(query, type, opts) {
        return this.requireExplorer().getOrderEdits(query, type, opts);
    },

    async getOrderExpires(query, type, opts) {
        return this.requireExplorer().getOrderExpires(query, type, opts);
    },

    // Completed order matches (auto-matched counter-orders; type 'block').
    async getOrderMatches(query, type, opts) {
        return this.requireExplorer().getOrderMatches(query, type, opts);
    },

    async getSends(query, type, opts) {
        return this.requireExplorer().getSends(query, type, opts);
    },

    async getSleeps(query, type, opts) {
        return this.requireExplorer().getSleeps(query, type, opts);
    },

    async getSwaps(query, type, opts) {
        return this.requireExplorer().getSwaps(query, type, opts);
    },

    // Swap lifecycle events (cancellations), type ∈ {block, address}.
    async getSwapCancels(query, type, opts) {
        return this.requireExplorer().getSwapCancels(query, type, opts);
    },

    async getSwapEdits(query, type, opts) {
        return this.requireExplorer().getSwapEdits(query, type, opts);
    },

    async getSwapExpires(query, type, opts) {
        return this.requireExplorer().getSwapExpires(query, type, opts);
    },

    // Completed swap matches (type 'block'; the explorer keys matches by block).
    async getSwapMatches(query, type, opts) {
        return this.requireExplorer().getSwapMatches(query, type, opts);
    },

    async getSweeps(query, type, opts) {
        return this.requireExplorer().getSweeps(query, type, opts);
    },


    /*
     *  Explorer: Contract / VM Methods
     */

    async getContract(contractActionIndex) {
        return this.requireExplorer().getContract(contractActionIndex);
    },

    // Read a contract's declared permissions manifest (programmable policy layer),
    // normalized to { permissions: string[]|null, maxTakeBps: number|null }.
    // permissions=null → unrestricted (no declared allowlist); maxTakeBps=null →
    // the global fee cap applies. Backs the wallet consent disclosure.
    async getContractManifest(contractActionIndex) {
        return this.requireExplorer().getContractManifest(contractActionIndex);
    },

    async getContracts(query, type, opts) {
        return this.requireExplorer().getContracts(query, type, opts);
    },

    async getContractState(contractActionIndex, key) {
        return this.requireExplorer().getContractState(contractActionIndex, key);
    },

    async getContractBalance(contractActionIndex, tick) {
        return this.requireExplorer().getContractBalance(contractActionIndex, tick);
    },

    // Read External Attestation Framework rows (ATTEST v0 requests + v1/v2
    // responses from the `attests` table). type ∈ {block, address, contract}.
    // A dapp polls this to learn its attestation request's status/result.
    async getAttestations(query, type, opts) {
        return this.requireExplorer().getAttestations(query, type, opts);
    },

    // Read XCALL cross-chain calls (VM-emitted, read-only; no submit path). List the
    // source-chain requests (type ∈ {block, contract, status}); a dapp polls getXcall(callId)
    // for one call's full lifecycle (request + target execution + source callback).
    async getXcalls(query, type, opts) {
        return this.requireExplorer().getXcalls(query, type, opts);
    },

    async getXcall(callId) {
        return this.requireExplorer().getXcall(callId);
    },

    async getExecution(executionActionIndex) {
        return this.requireExplorer().getExecution(executionActionIndex);
    },

    async getExecutions(query, type = 'contract', opts = {}) {
        return this.requireExplorer().getExecutions(query, type, opts);
    },

    async getDeposits(query, type, opts) {
        return this.requireExplorer().getDeposits(query, type, opts);
    },

    async getWithdrawals(query, type, opts) {
        return this.requireExplorer().getWithdrawals(query, type, opts);
    },
};
