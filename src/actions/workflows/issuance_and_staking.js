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
 * XChain Platform SDK - Workflow Recipes
 *
 * High-level helpers that compose multiple actions into common
 * workflows. Built on WalletSession + submitAction.
 *
 ********************************************************************/

const Utility = require('../../utils/utility.js');

module.exports = {
    // Issue a token and immediately distribute it to recipients.
    //
    // wif           - WIF private key of the issuer
    // issueParams   - ISSUE action params (tick, maxSupply, decimals, etc.)
    // distributions - [{ destination, amount }, ...]
    // opts          - submit options (waitForIndexer, timeout, etc.)
    //
    // Returns: { issue: <submitResult>, sends: [<submitResult>, ...] }
    async issueAndDistribute(wif, issueParams, distributions, opts = {}) {
        let session = this.sdk.session(wif, opts);
        return this.withPartial({ issue: null, sends: [] }, async (p) => {
            p.issue = await session.issue(issueParams, {}, opts);
            for (let dist of distributions) {
                p.sends.push(await session.send({
                    tick:        issueParams.tick,
                    amount:      dist.amount,
                    destination: dist.destination,
                    memo:        dist.memo
                }, {}, opts));
            }
            return p;
        });
    },

    // Issue a token and immediately mint the initial supply.
    //
    // wif         - WIF private key
    // issueParams - ISSUE action params (tick, maxSupply, etc.)
    // mintParams  - MINT action params (amount, destination; tick is auto-filled)
    // opts        - submit options
    //
    // Returns: { issue: <submitResult>, mint: <submitResult> }
    async issueAndMint(wif, issueParams, mintParams, opts = {}) {
        let session = this.sdk.session(wif, opts);
        return this.withPartial({ issue: null, mint: null }, async (p) => {
            p.issue = await session.issue(issueParams, {}, opts);
            p.mint  = await session.mint({ tick: issueParams.tick, ...mintParams }, {}, opts);
            return p;
        });
    },

    // Create a dispenser: issue token (if needed), then create dispenser.
    //
    // wif             - WIF private key
    // dispenserParams - DISPENSER action params (giveTick, giveAmount, getTick, getAmount, etc.)
    // opts            - submit options
    //
    // Returns: <submitResult>
    async createDispenser(wif, dispenserParams, opts = {}) {
        let session = this.sdk.session(wif, opts);
        return session.dispenser(dispenserParams, {}, opts);
    },

    // Create a limit order on the DEX.
    //
    // wif         - WIF private key
    // orderParams - ORDER action params (giveTick, giveAmount, getTick, getAmount, etc.)
    // opts        - submit options
    //
    // Returns: <submitResult>
    async createOrder(wif, orderParams, opts = {}) {
        let session = this.sdk.session(wif, opts);
        return session.order(orderParams, {}, opts);
    },

    // Cancel an existing order.
    //
    // wif              - WIF private key
    // orderActionIndex - action_index of the order to cancel
    // opts             - submit options
    //
    // Returns: <submitResult>
    async cancelOrder(wif, orderActionIndex, opts = {}) {
        let session = this.sdk.session(wif, opts);
        return session.order({ orderActionIndex }, {}, opts);
    },

    // Stake and optionally delegate a signing key in one flow.
    //
    // wif            - WIF private key
    // stakeParams    - STAKE action params (version, amount, signingPubkey)
    //                  version=1 for a new stake, version=2 to top up an existing pubkey
    // delegateParams - DELEGATE action params (newSigningPubkey); optional, omit to skip
    // opts           - submit options
    //
    // Returns: { stake: <submitResult>, delegate: <submitResult>|null }
    async stakeAndDelegate(wif, stakeParams, delegateParams, opts = {}) {
        let session = this.sdk.session(wif, opts);
        return this.withPartial({ stake: null, delegate: null }, async (p) => {
            p.stake = await session.stake(stakeParams, {}, opts);
            if (delegateParams)
                p.delegate = await session.delegate(delegateParams, {}, opts);
            return p;
        });
    },

    // Stake to a contract and optionally delegate the signing key in one flow.
    //
    // wif            - WIF private key
    // stakeParams    - { AMOUNT, SIGNING_PUBKEY, TARGET_CONTRACT_INDEX, TICK }
    // delegateParams - { SIGNING_PUBKEY, TARGET_CONTRACT_INDEX, TICK } (optional)
    // opts           - submit options
    //
    // Returns: { stake: <submitResult>, delegate: <submitResult>|null }
    async stakeToContractAndDelegate(wif, stakeParams, delegateParams, opts = {}) {
        let session = this.sdk.session(wif, opts);
        return this.withPartial({ stake: null, delegate: null }, async (p) => {
            p.stake = await session.stakeToContract(stakeParams, {}, opts);
            if (delegateParams)
                p.delegate = await session.delegateForContract(delegateParams, {}, opts);
            return p;
        });
    },

    // Deploy a stakeable smart contract. Enforces presence of COOLDOWN_BLOCKS +
    // SLASH_DESTINATION metadata so the resulting contract can accept STAKE v3 actions.
    //
    // wif           - WIF private key
    // deployParams  - DEPLOY action params; MUST include COOLDOWN_BLOCKS (1..100000) and
    //                 SLASH_DESTINATION (address or 'BURN' sentinel). VERSION is forced to 1.
    // deposits      - [{ tick, quantity }, ...] (optional initial token deposits)
    // opts          - submit options, plus opts.preflight (see deployAndFund: the
    //                 contract-identity check runs before anything is composed)
    //
    // Returns: { deploy: <submitResult>, deposits: [<submitResult>, ...] }
    async deployStakeableContract(wif, deployParams, deposits, opts = {}) {
        if (!deployParams || deployParams.COOLDOWN_BLOCKS === undefined || deployParams.COOLDOWN_BLOCKS === null || deployParams.COOLDOWN_BLOCKS === '')
            throw new Error('deployStakeableContract: COOLDOWN_BLOCKS is required');
        if (!deployParams.SLASH_DESTINATION)
            throw new Error('deployStakeableContract: SLASH_DESTINATION is required');
        return this.deployAndFund(wif, Utility.withForcedVersion('1', deployParams), deposits, opts);
    }
};
