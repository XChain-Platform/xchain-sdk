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

const EncoderClient = require('../clients/encoder.js');
const LifecycleManager = require('../carrier/lifecycle_manager.js');

// Keep action delegates together so the public action surface stays easy to audit.
module.exports = {


    /*
     *  ACTION Methods
     */

    // Create an action string and optionally encode it into a PSBT.
    // If data.encoder contains pubkey, calls the encoder and returns the PSBT.
    async createAction(data) {
        // Compact ticker names and addresses to their `^<id>` wire form before
        // serializing (on by default; each falls back to the supplied value when an
        // id can't be resolved). The two resolvers touch disjoint fields and each
        // returns a fresh shallow copy, so chaining them never mutates the caller's
        // data object.
        if (data && data.params) {
            let params = await this.tickResolver.resolveActionParams(data.action, data.params);
            params = await this.addressResolver.resolveActionParams(data.action, params);
            data = Object.assign({}, data, { params });
        }
        let result = this.actions.createAction(data);

        if (data.encoder && data.encoder.pubkey) {
            let encoder = this.requireEncoder();
            // Forward every optional createTx field through the ONE shared list
            // (EncoderClient.CREATE_TX_OPTION_FIELDS), never a hand-copied subset:
            // the hand-copied version had silently fallen behind createTx and was
            // dropping feeQuote, compress, options and sourceAddress.
            let txResult = await encoder.createTx(EncoderClient.pickCreateTxOptions(data.encoder, {
                data:   result.actionString,
                pubkey: data.encoder.pubkey
            }));
            result.psbt     = txResult.psbt;
            result.encoding = txResult.encoding;
        }

        return result;
    },

    // Submit an action through the full lifecycle: create, encode, sign, broadcast, wait.
    // actionData = { action, params }; encoderOpts = { pubkey, change, utxos, encoding, fee, ... };
    // opts = { wif, waitForIndexer, timeout, pollInterval, requireValid, strictStatus, onProgress }.
    // With waitForIndexer (default), a chain-REJECTED action REJECTS this call with
    // SDKActionError ACTION_REJECTED carrying the indexer's reason; the resolved
    // result's `indexed.statusKnown` says whether the status was read or assumed
    // (strictStatus:true rejects rather than assume - see actionWaiter).
    async submitAction(actionData, encoderOpts, opts) {
        let mgr = new LifecycleManager(this);
        return mgr.submitAction(actionData, encoderOpts, opts);
    },

    validateAction(action, params) {
        return this.actions.validateAction(action, params);
    },

    getActions() {
        return this.actions.getActions();
    },

    getActionFormats(action) {
        return this.actions.getActionFormats(action);
    },

    getActionFields(action, version) {
        return this.actions.getActionFields(action, version);
    },


    /*
     *  Convenience Action Methods
     *  Each wraps createAction with a fixed action name.
     *  sdk.send(params, encoderOpts?) is shorthand for
     *  sdk.createAction({ action: 'SEND', params, encoder: encoderOpts })
     */

    async send(params, encoder)      { return this.createAction({ action: 'SEND', params, encoder }); },
    async issue(params, encoder)     { return this.createAction({ action: 'ISSUE', params, encoder }); },
    async mint(params, encoder)      { return this.createAction({ action: 'MINT', params, encoder }); },
    async destroy(params, encoder)   { return this.createAction({ action: 'DESTROY', params, encoder }); },
    async order(params, encoder)     { return this.createAction({ action: 'ORDER', params, encoder }); },
    async transfer(params, encoder)  { return this.createAction({ action: 'SEND', params, encoder }); },
    async broadcast(params, encoder) { return this.createAction({ action: 'BROADCAST', params, encoder }); },
    async dispenser(params, encoder) { return this.createAction({ action: 'DISPENSER', params, encoder }); },
    async dividend(params, encoder)  { return this.createAction({ action: 'DIVIDEND', params, encoder }); },
    async sweep(params, encoder)     { return this.createAction({ action: 'SWEEP', params, encoder }); },
    async swap(params, encoder)      { return this.createAction({ action: 'SWAP', params, encoder }); },
    async callback(params, encoder)  { return this.createAction({ action: 'CALLBACK', params, encoder }); },
    async coinpay(params, encoder)   { return this.createAction({ action: 'COINPAY', params, encoder }); },
    async sleep(params, encoder)     { return this.createAction({ action: 'SLEEP', params, encoder }); },
    async airdrop(params, encoder)   { return this.createAction({ action: 'AIRDROP', params, encoder }); },
    async message(params, encoder)   { return this.createAction({ action: 'MESSAGE', params, encoder }); },
    async list(params, encoder)      { return this.createAction({ action: 'LIST', params, encoder }); },
    async link(params, encoder)      { return this.createAction({ action: 'LINK', params, encoder }); },
    async file(params, encoder)      { return this.createAction({ action: 'FILE', params, encoder }); },
    async address(params, encoder)   { return this.createAction({ action: 'ADDRESS', params, encoder }); },
    // PRICE: only v1 (permissionless user-run TOKEN/FIAT oracle) is SDK-encodable;
    // formats.js has no v0, so the validator COIN/FIAT snapshot can never be built here.
    // Params: { coin, tick, fiat, value, fee, memo }. See protocol/actions/PRICE.md.
    async price(params, encoder)     { return this.createAction({ action: 'PRICE', params, encoder }); },

    // VOTE (token-weighted governance). Raw wrapper: the version is taken from
    // params.version (0 create / 1 ballot / 3 delegate). Build the params with
    // sdk.voting.* or hand-roll them. v2 (finalize) is system-only. For a
    // signed+broadcast round-trip use sdk.createPoll / castBallot / delegateVote.
    async vote(params, encoder)             { return this.createAction({ action: 'VOTE', params, encoder }); },

    // BET (parimutuel betting). Raw wrapper: the version is taken from
    // params.version (0 create / 1 cancel / 2 place / 3 resolve). Build the
    // params with sdk.betting.* so OUTCOMES and DETAILS are composed together
    // and the version is pinned; auto-selection would otherwise read a resolve
    // with no AMOUNT and a place-bet as neighbouring shapes. For a
    // signed+broadcast round-trip use sdk.workflows.openMarket / placeBet /
    // resolveMarket / cancelMarket.
    async bet(params, encoder)              { return this.createAction({ action: 'BET', params, encoder }); },

    // XBRIDGE (cross-chain lock/burn/settle, xchain-bridge.md / xchain-token-bridge.md).
    // Raw wrapper: the version is taken from params.version (0 lock XCHAIN / 1 burn
    // XCHAIN / 3 lock a token / 4 burn a bridged token). v2 and v5 are the
    // system-injected settle legs and are refused if broadcast. opts is accepted
    // for symmetry with the other builders (deploy, submitAction) but is not
    // required here: the coin-and-network-aware address validation lives in the
    // sdk.workflows.bridgeLock / bridgeBurn / bridgeTokenLock / bridgeTokenBurn
    // recipes, which pin the version and validate the destination before this
    // builder is ever reached. Use those for a signed+broadcast round trip.
    async xbridge(params, encoder, opts = {}) { return this.createAction({ action: 'XBRIDGE', params, encoder }); },

    async stake(params, encoder)            { return this.createAction({ action: 'STAKE', params, encoder }); },
    async unstake(params, encoder)          { return this.createAction({ action: 'UNSTAKE', params, encoder }); },
    async delegate(params, encoder)         { return this.createAction({ action: 'DELEGATE', params, encoder }); },
    async collect(params, encoder)          { return this.createAction({ action: 'COLLECT', params, encoder }); },
};
