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

const BatchBuilder = require('../carrier/batch_builder.js');

// Keep workflow delegates together so multi-action entry points stay discoverable.
module.exports = {

    async issueAndDistribute(wif, issueParams, distributions, opts) {
        return this.workflows.issueAndDistribute(wif, issueParams, distributions, opts);
    },
    async issueAndMint(wif, issueParams, mintParams, opts) {
        return this.workflows.issueAndMint(wif, issueParams, mintParams, opts);
    },
    async createDispenser(wif, dispenserParams, opts) {
        return this.workflows.createDispenser(wif, dispenserParams, opts);
    },
    async createOrder(wif, orderParams, opts) {
        return this.workflows.createOrder(wif, orderParams, opts);
    },
    async cancelOrder(wif, orderActionIndex, opts) {
        return this.workflows.cancelOrder(wif, orderActionIndex, opts);
    },
    async stakeAndDelegate(wif, stakeParams, delegateParams, opts) {
        return this.workflows.stakeAndDelegate(wif, stakeParams, delegateParams, opts);
    },
    async deployAndFund(wif, deployParams, deposits, opts) {
        return this.workflows.deployAndFund(wif, deployParams, deposits, opts);
    },
    // Deploy auto-selecting single-shot vs chunked (DEPLOY v4 carriers + DEPLOY v2/v3) by source
    // size, then optionally fund. Pass raw `code` so the planner can size it. See
    // workflows.deployContract / chunkHelper. Spec: protocol/actions/DEPLOY.md.
    async deployContract(wif, deployParams, deposits, opts) {
        return this.workflows.deployContract(wif, deployParams, deposits, opts);
    },
    async distributeDividend(wif, dividendParams, opts) {
        return this.workflows.distributeDividend(wif, dividendParams, opts);
    },
    async issueNft(wif, params, opts) {
        return this.workflows.issueNft(wif, params, opts);
    },
    async issueNftEdition(wif, params, opts) {
        return this.workflows.issueNftEdition(wif, params, opts);
    },
    async issueCollectionItem(wif, params, opts) {
        return this.workflows.issueCollectionItem(wif, params, opts);
    },
    async attachContent(wif, params, opts) {
        return this.workflows.attachContent(wif, params, opts);
    },
    async setRoster(wif, params, opts) {
        return this.workflows.setRoster(wif, params, opts);
    },
    // Governance submit recipes: build the VOTE params (via sdk.voting.*) then
    // sign + broadcast in one call. `params` is the same object the matching
    // sdk.voting builder takes. Set opts.waitForIndexer to get back the poll's
    // action_index (needed as pollRef for later ballots).
    async createPoll(wif, params, opts) {
        return this.workflows.createPoll(wif, params, opts);
    },
    async castBallot(wif, params, opts) {
        return this.workflows.castBallot(wif, params, opts);
    },
    async delegateVote(wif, params, opts) {
        return this.workflows.delegateVote(wif, params, opts);
    },
    async clearVoteDelegation(wif, params, opts) {
        return this.workflows.clearVoteDelegation(wif, params, opts);
    },

    // Usage: await sdk.batch().send({...}).mint({...}).build(encoderOpts?)
    // build() is async; passing the un-awaited Promise to submitAction will not work.
    batch() {
        return new BatchBuilder(this);
    },


    /*
     *  Encoder Methods
     */

    async encodeTx(params) {
        return this._requireEncoder().createTx(params);
    },

    async spendP2sh(params) {
        return this._requireEncoder().spendP2sh(params);
    },
};
