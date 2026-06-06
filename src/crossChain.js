/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Platform SDK - Cross-Chain Helper
 *
 * Coordinates actions across multiple SDK instances connected to
 * different blockchains (BTC, LTC, DOGE).
 *
 * Usage:
 *   const bridge = new CrossChainHelper({
 *       BTC: btcSdk,
 *       LTC: ltcSdk
 *   });
 *   await bridge.swap({ ... });
 *
 ********************************************************************/

const { SDKConfigError, SDKActionError } = require('./errors.js');


class CrossChainHelper {

    // sdkMap: { 'BTC': sdkInstance, 'LTC': sdkInstance, 'DOGE': sdkInstance }
    // Keys can be coin symbols (BTC/LTC/DOGE) or full network strings (bitcoin-mainnet)
    constructor(sdkMap) {
        if (!sdkMap || typeof sdkMap !== 'object' || Object.keys(sdkMap).length < 2)
            throw new SDKConfigError('INVALID_SDK_MAP', 'CrossChainHelper requires at least 2 SDK instances');

        this.sdks = {};
        for (let key in sdkMap) {
            this.sdks[key.toUpperCase()] = sdkMap[key];
        }
    }

    // Get the SDK for a given chain identifier
    _requireSDK(chain) {
        let key = String(chain).toUpperCase();
        let sdk = this.sdks[key];
        if (!sdk)
            throw new SDKConfigError('CHAIN_NOT_CONFIGURED',
                'No SDK configured for chain: ' + chain + '. Available: ' + Object.keys(this.sdks).join(', '));
        return sdk;
    }

    // Create matching swap offers on two different chains.
    //
    // This creates a SWAP action on the "give" chain and expects the
    // counterparty to create a matching SWAP on the "get" chain.
    //
    // params:
    //   giveCoin     - chain to give from (e.g., 'BTC')
    //   giveTick     - token to give
    //   giveAmount   - amount to give
    //   getCoin      - chain to get on (e.g., 'LTC')
    //   getTick      - token to get
    //   getAmount    - amount to get
    //   wif          - WIF private key for the give chain
    //   expiration   - block height expiration (optional)
    //   opts         - submit options
    //
    // Returns: { swap: <submitResult> }
    async createSwap(params, opts = {}) {
        let sdk = this._requireSDK(params.giveCoin);
        let session = sdk.session(params.wif, opts);

        let swapResult = await session.swap({
            giveCoin:   params.giveCoin,
            giveTick:   params.giveTick,
            giveAmount: params.giveAmount,
            getCoin:    params.getCoin,
            getTick:    params.getTick,
            getAmount:  params.getAmount,
            getAddress: params.getAddress,
            expiration: params.expiration,
            allowList:  params.allowList,
            blockList:  params.blockList,
            memo:       params.memo
        }, {}, opts);

        return { swap: swapResult };
    }

    // Create a LINK between actions on two different chains.
    //
    // params:
    //   coin1            - first chain (e.g., 'BTC')
    //   coin1ActionIndex - action_index on first chain
    //   coin2            - second chain (e.g., 'LTC')
    //   coin2ActionIndex - action_index on second chain
    //   wif              - WIF private key (for the chain where LINK is submitted)
    //   submitOn         - which chain to submit the LINK on (defaults to coin1)
    //   opts             - submit options
    //
    // Returns: <submitResult>
    async link(params, opts = {}) {
        let submitChain = params.submitOn || params.coin1;
        let sdk = this._requireSDK(submitChain);
        let session = sdk.session(params.wif, opts);

        return session.link({
            coin1:            params.coin1,
            coin1ActionIndex: params.coin1ActionIndex,
            coin2:            params.coin2,
            coin2ActionIndex: params.coin2ActionIndex,
            memo:             params.memo
        }, {}, opts);
    }

    // Execute actions on multiple chains in parallel.
    //
    // actions: [{
    //   chain:       'BTC',
    //   wif:         '...',
    //   actionData:  { action: 'SEND', params: {...} },
    //   encoderOpts: {},    // optional
    //   submitOpts:  {}     // optional
    // }, ...]
    //
    // Returns: array of submitAction results (in same order as input)
    async parallel(actions) {
        return Promise.all(actions.map(a => {
            let sdk = this._requireSDK(a.chain);
            let session = sdk.session(a.wif, a.submitOpts);
            return session.submit(a.actionData, a.encoderOpts || {}, a.submitOpts || {});
        }));
    }

    // Wait for actions on multiple chains simultaneously.
    //
    // waits: [{ chain: 'BTC', txid: '...' }, { chain: 'LTC', txid: '...' }]
    // opts:  { timeout, pollInterval }
    //
    // Returns: array of action objects from each chain's explorer
    async waitForAll(waits, opts = {}) {
        return Promise.all(waits.map(w => {
            let sdk = this._requireSDK(w.chain);
            return sdk.waitForAction(w.txid, opts);
        }));
    }

    // Get balances across all configured chains for a given address.
    // Note: the address must be valid on each chain's network.
    //
    // Returns: { BTC: [...balances], LTC: [...balances], ... }
    async getAllBalances(address, opts = {}) {
        let results = {};
        let promises = Object.entries(this.sdks).map(async ([chain, sdk]) => {
            try {
                results[chain] = await sdk.getBalances(address, opts);
            } catch (e) {
                results[chain] = { error: e.message };
            }
        });
        await Promise.all(promises);
        return results;
    }

}

module.exports = CrossChainHelper;
