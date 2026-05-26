/*********************************************************************
 *
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 *
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided "AS IS", without warranties or conditions of any kind.
 *
 **********************************************************************
 *
 * XChain Platform SDK - Workflow Recipes
 *
 * High-level helpers that compose multiple actions into common
 * workflows. Built on WalletSession + submitAction.
 *
 ********************************************************************/

const WalletSession = require('./walletSession.js');


class Workflows {

    constructor(sdk) {
        this.sdk = sdk;
    }

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

        // Step 1: Issue the token
        let issueResult = await session.issue(issueParams, {}, opts);

        // Step 2: Send to each recipient
        let sends = [];
        for (let dist of distributions) {
            let sendResult = await session.send({
                tick:        issueParams.tick,
                amount:      dist.amount,
                destination: dist.destination,
                memo:        dist.memo
            }, {}, opts);
            sends.push(sendResult);
        }

        return { issue: issueResult, sends };
    }

    // Issue a token and immediately mint the initial supply.
    //
    // wif         - WIF private key
    // issueParams - ISSUE action params (tick, maxSupply, etc.)
    // mintParams  - MINT action params (amount, destination — tick is auto-filled)
    // opts        - submit options
    //
    // Returns: { issue: <submitResult>, mint: <submitResult> }
    async issueAndMint(wif, issueParams, mintParams, opts = {}) {
        let session = this.sdk.session(wif, opts);

        let issueResult = await session.issue(issueParams, {}, opts);
        let mintResult  = await session.mint({
            tick: issueParams.tick,
            ...mintParams
        }, {}, opts);

        return { issue: issueResult, mint: mintResult };
    }

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
    }

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
    }

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
    }

    // Stake and optionally delegate a signing key in one flow.
    //
    // wif            - WIF private key
    // stakeParams    - STAKE action params (version, amount, signingPubkey)
    //                  version=1 for a new stake, version=2 to top up an existing pubkey
    // delegateParams - DELEGATE action params (newSigningPubkey) — optional, omit to skip
    // opts           - submit options
    //
    // Returns: { stake: <submitResult>, delegate: <submitResult>|null }
    async stakeAndDelegate(wif, stakeParams, delegateParams, opts = {}) {
        let session = this.sdk.session(wif, opts);

        let stakeResult = await session.stake(stakeParams, {}, opts);
        let delegateResult = null;

        if (delegateParams) {
            delegateResult = await session.delegate(delegateParams, {}, opts);
        }

        return { stake: stakeResult, delegate: delegateResult };
    }

    // Stake to a contract and optionally delegate the signing key in one flow.
    //
    // wif            - WIF private key
    // stakeParams    - { AMOUNT, SIGNING_PUBKEY, TARGET_CONTRACT_INDEX, TICK }
    // delegateParams - { SIGNING_PUBKEY, TARGET_CONTRACT_INDEX, TICK } — optional
    // opts           - submit options
    //
    // Returns: { stake: <submitResult>, delegate: <submitResult>|null }
    async stakeToContractAndDelegate(wif, stakeParams, delegateParams, opts = {}) {
        let session = this.sdk.session(wif, opts);
        let stakeResult = await session.stakeToContract(stakeParams, {}, opts);
        let delegateResult = null;
        if (delegateParams) {
            delegateResult = await session.delegateForContract(delegateParams, {}, opts);
        }
        return { stake: stakeResult, delegate: delegateResult };
    }

    // Deploy a stakeable smart contract — enforces presence of COOLDOWN_BLOCKS + SLASH_DESTINATION
    // metadata so the resulting contract can accept STAKE v3 actions.
    //
    // wif           - WIF private key
    // deployParams  - DEPLOY action params; MUST include COOLDOWN_BLOCKS (1..100000) and
    //                 SLASH_DESTINATION (address or 'BURN' sentinel). VERSION is forced to 1.
    // deposits      - [{ tick, quantity }, ...] — optional initial token deposits
    // opts          - submit options
    //
    // Returns: { deploy: <submitResult>, deposits: [<submitResult>, ...] }
    async deployStakeableContract(wif, deployParams, deposits, opts = {}) {
        if (!deployParams || deployParams.COOLDOWN_BLOCKS === undefined || deployParams.COOLDOWN_BLOCKS === null || deployParams.COOLDOWN_BLOCKS === '')
            throw new Error('deployStakeableContract: COOLDOWN_BLOCKS is required');
        if (!deployParams.SLASH_DESTINATION)
            throw new Error('deployStakeableContract: SLASH_DESTINATION is required');
        return this.deployAndFund(wif, { VERSION: '1', ...deployParams }, deposits, opts);
    }

    // Deploy a smart contract and optionally deposit initial tokens.
    //
    // wif           - WIF private key
    // deployParams  - DEPLOY action params (code/codeEncoding, gasLimit, constructorParams)
    // deposits      - [{ tick, quantity }, ...] — optional initial token deposits
    // opts          - submit options
    //
    // Returns: { deploy: <submitResult>, deposits: [<submitResult>, ...] }
    async deployAndFund(wif, deployParams, deposits, opts = {}) {
        let session = this.sdk.session(wif, opts);

        let deployResult = await session.deploy(deployParams, {}, opts);

        let depositResults = [];
        if (deposits && deposits.length > 0) {
            // Use the action_index from the deploy result for the contract reference
            let contractActionIndex = deployResult.indexed
                ? deployResult.indexed.action_index
                : null;

            if (contractActionIndex !== null) {
                for (let dep of deposits) {
                    let result = await session.deposit({
                        contractActionIndex,
                        tick:     dep.tick,
                        quantity: dep.quantity
                    }, {}, opts);
                    depositResults.push(result);
                }
            }
        }

        return { deploy: deployResult, deposits: depositResults };
    }

    // Distribute a dividend to all holders of a token.
    //
    // wif            - WIF private key
    // dividendParams - DIVIDEND action params (tick, dividendTick, amount)
    // opts           - submit options
    //
    // Returns: <submitResult>
    async distributeDividend(wif, dividendParams, opts = {}) {
        let session = this.sdk.session(wif, opts);
        return session.dividend(dividendParams, {}, opts);
    }

}

module.exports = Workflows;
