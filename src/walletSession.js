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
 * XChain Platform SDK - Wallet Session
 *
 * Bound wallet object that bundles address/key/UTXO state with
 * action convenience methods. Provides a "I am this address" mental
 * model for developers.
 *
 * Usage:
 *   let session = sdk.session(wif);
 *   await session.send({ tick: 'TOKEN', amount: '100', destination: addr });
 *   let balances = await session.getBalances();
 *
 ********************************************************************/

const UTXOCache        = require('./utxoCache.js');
const LifecycleManager = require('./lifecycleManager.js');
const Utility          = require('./utility.js');
const { SDKWalletError } = require('./errors.js');


class WalletSession {

    constructor(sdk, wif, opts = {}) {
        if (!wif) throw new SDKWalletError('INVALID_WIF', 'WIF is required for WalletSession');

        this.sdk = sdk;

        // Import key and derive address
        let keyInfo    = sdk.wallet.importWIF(wif);
        this.wif       = wif;
        this.pubkey    = keyInfo.publicKeyHex;
        this.publicKey = keyInfo.publicKey;
        this.address   = sdk.wallet.deriveAddress(keyInfo.publicKey, { type: opts.addressType || 'p2pkh' });
        this.compressed = keyInfo.compressed;

        // UTXO cache for transaction chaining
        this._utxoCache = new UTXOCache();

        // Serializes submit() calls from this session. The submits share one
        // UTXO cache, and each does read-available -> broadcast -> mark-spent
        // with a long async gap in the middle; two concurrent sends would both
        // reserve the same UTXOs and one would double-spend. This tail promise
        // chains each submit behind the previous, so concurrent callers queue
        // safely instead of racing the cache. (Same idiom as x402's per-nonce
        // mutex and the deposit-ledger lock.)
        this._submitTail = Promise.resolve();

        // Default submit options
        this._defaultOpts = {
            waitForIndexer: opts.waitForIndexer !== undefined ? opts.waitForIndexer : true,
            timeout:        opts.timeout || 120000,
            pollInterval:   opts.pollInterval || 2000,
            requireValid:   opts.requireValid !== false
        };
    }

    // Refresh UTXO set from the UTXO tracker
    async refreshUTXOs() {
        let encoder = this.sdk._requireEncoder();
        return this._utxoCache.refresh(this.address, encoder);
    }

    // Submit any action using this session's key, address, and UTXO cache
    // actionData     = { action, params }
    // encoderOpts    = override encoder options (optional)
    // submitOpts     = override submit options (optional)
    //
    // Submits are serialized per session (see _submitTail): if a caller fires
    // several sends concurrently, they queue rather than racing the shared UTXO
    // cache into a double-spend. A failed submit does not block the queue.
    async submit(actionData, encoderOpts = {}, submitOpts = {}) {
        let run = this._submitTail.then(() => this._submitInner(actionData, encoderOpts, submitOpts));
        // Advance the tail regardless of this submit's outcome so one failure
        // (or rejection) never wedges every later send behind it.
        this._submitTail = run.then(() => {}, () => {});
        return run;
    }

    async _submitInner(actionData, encoderOpts = {}, submitOpts = {}) {
        // Lazy-load UTXOs if cache is empty and no explicit UTXOs provided
        if (!encoderOpts.utxos && !this._utxoCache.isLoaded()) {
            await this.refreshUTXOs();
        }

        let utxos = this._utxoCache.getAvailable();
        // A prior submit in this session drains the cache (spent inputs are
        // marked, but the change output isn't tracked), so the second leg of
        // a two-step workflow (setRoster, attachContent) would otherwise fall
        // through to the encoder's pubkey-keyed UTXO fetch, which cannot
        // resolve a hex pubkey to an address. With waitForIndexer (the
        // default) the prior action's change is confirmed by now: re-pull it.
        if (!encoderOpts.utxos && utxos.length === 0 && this._utxoCache.isLoaded()) {
            await this.refreshUTXOs();
            utxos = this._utxoCache.getAvailable();
        }

        let mergedEncoder = {
            // The encoder's `pubkey` field is the SENDER identity and must be
            // the ADDRESS: the P2SH/P2WSH data-script path base58-decodes it
            // (a hex pubkey throws "Non-base58 character" as soon as an action
            // string outgrows OP_RETURN), and the UTXO-fetch fallback can only
            // key on an address.
            pubkey: this.address,
            change: this.address,
            ...encoderOpts
        };
        // Only inject cached UTXOs if caller didn't provide their own
        if (!encoderOpts.utxos && utxos.length > 0) {
            mergedEncoder.utxos = utxos;
        }

        let mergedOpts = {
            ...this._defaultOpts,
            ...submitOpts,
            wif: this.wif
        };

        let mgr = new LifecycleManager(this.sdk);
        let result = await mgr.submitAction(actionData, mergedEncoder, mergedOpts);

        // Update UTXO cache: mark spent inputs, add speculative change
        if (result.spentInputs) {
            this._utxoCache.markSpent(result.spentInputs);
        }

        return result;
    }


    /*
     *  Action Convenience Methods
     *  Each wraps submit() with a fixed action name.
     */

    // Token lifecycle
    async send(params, enc, opts)      { return this.submit({ action: 'SEND', params }, enc, opts); }
    async issue(params, enc, opts)     { return this.submit({ action: 'ISSUE', params }, enc, opts); }
    async mint(params, enc, opts)      { return this.submit({ action: 'MINT', params }, enc, opts); }
    async destroy(params, enc, opts)   { return this.submit({ action: 'DESTROY', params }, enc, opts); }
    async transfer(params, enc, opts)  { return this.submit({ action: 'SEND', params }, enc, opts); }

    // Trading
    async order(params, enc, opts)     { return this.submit({ action: 'ORDER', params }, enc, opts); }
    async swap(params, enc, opts)      { return this.submit({ action: 'SWAP', params }, enc, opts); }
    async coinpay(params, enc, opts)   { return this.submit({ action: 'COINPAY', params }, enc, opts); }
    async dispenser(params, enc, opts) { return this.submit({ action: 'DISPENSER', params }, enc, opts); }

    // Distribution
    async dividend(params, enc, opts)  { return this.submit({ action: 'DIVIDEND', params }, enc, opts); }
    async airdrop(params, enc, opts)   { return this.submit({ action: 'AIRDROP', params }, enc, opts); }
    async sweep(params, enc, opts)     { return this.submit({ action: 'SWEEP', params }, enc, opts); }

    // Communication
    async broadcast(params, enc, opts) { return this.submit({ action: 'BROADCAST', params }, enc, opts); }
    async message(params, enc, opts)   { return this.submit({ action: 'MESSAGE', params }, enc, opts); }
    async file(params, enc, opts)      { return this.submit({ action: 'FILE', params }, enc, opts); }

    // Utility
    async list(params, enc, opts)      { return this.submit({ action: 'LIST', params }, enc, opts); }
    async link(params, enc, opts)      { return this.submit({ action: 'LINK', params }, enc, opts); }
    async callback(params, enc, opts)  { return this.submit({ action: 'CALLBACK', params }, enc, opts); }
    async sleep(params, enc, opts)     { return this.submit({ action: 'SLEEP', params }, enc, opts); }
    async address(params, enc, opts)   { return this.submit({ action: 'ADDRESS', params }, enc, opts); }

    // Oracle: permissionless user-run TOKEN/FIAT price (PRICE v1). Only v1 is
    // SDK-encodable (formats.js has no v0), so the encoder always selects it.
    // Params: { coin, tick, fiat, value, fee, memo }. See protocol/actions/PRICE.md.
    async price(params, enc, opts)     { return this.submit({ action: 'PRICE', params }, enc, opts); }

    // Governance: VOTE (create poll / cast ballot / delegate). Build params with
    // sdk.voting.*; the version rides in params.version. v2 (finalize) is
    // system-only. See protocol/actions/VOTE.md.
    async vote(params, enc, opts)      { return this.submit({ action: 'VOTE', params }, enc, opts); }

    // Betting: BET (create market / cancel / place bet / resolve). Build params
    // with sdk.betting.*; the version rides in params.version. See
    // protocol/actions/BET.md.
    async bet(params, enc, opts)       { return this.submit({ action: 'BET', params }, enc, opts); }

    // Capability (validator) staking. The indexer coin-gates these versions
    // to Bitcoin; the contract-targeted lane below is not gated .
    async stake(params, enc, opts)            { return this.submit({ action: 'STAKE', params }, enc, opts); }
    async unstake(params, enc, opts)          { return this.submit({ action: 'UNSTAKE', params }, enc, opts); }
    async delegate(params, enc, opts)         { return this.submit({ action: 'DELEGATE', params }, enc, opts); }
    async collect(params, enc, opts)          { return this.submit({ action: 'COLLECT', params }, enc, opts); }

    // Contract-targeted staking (any token, ANY CHAIN - : STAKE v3 /
    // UNSTAKE v1 / DELEGATE v1 dispatch ahead of the indexer's BTC gate).
    // VERSION is forced by the helper (withForcedVersion, which throws rather
    // than route a caller-supplied version)
    // so callers can't accidentally route to capability staking. Pass
    // { AMOUNT, SIGNING_PUBKEY, TARGET_CONTRACT_INDEX, TICK } for stake;
    // { SIGNING_PUBKEY, TARGET_CONTRACT_INDEX, TICK } for unstake / delegate.
    async stakeToContract(params, enc, opts)     { return this.submit({ action: 'STAKE',    params: Utility.withForcedVersion('3', params) }, enc, opts); }
    async unstakeFromContract(params, enc, opts) { return this.submit({ action: 'UNSTAKE',  params: Utility.withForcedVersion('1', params) }, enc, opts); }
    async delegateForContract(params, enc, opts) { return this.submit({ action: 'DELEGATE', params: Utility.withForcedVersion('1', params) }, enc, opts); }

    // VM / Smart Contracts
    async deploy(params, enc, opts)      { return this.submit({ action: 'DEPLOY', params }, enc, opts); }
    // One base64 code slice of a chunked deploy. DEPLOY v4 carrier (see sdk.deployContract / chunkHelper).
    async deployChunk(params, enc, opts) { return this.submit({ action: 'DEPLOY', params: Utility.withForcedVersion('4', params) }, enc, opts); }
    async execute(params, enc, opts)   { return this.submit({ action: 'EXECUTE', params }, enc, opts); }
    async deposit(params, enc, opts)   { return this.submit({ action: 'DEPOSIT', params }, enc, opts); }
    async withdraw(params, enc, opts)  { return this.submit({ action: 'WITHDRAW', params }, enc, opts); }


    /*
     *  Explorer Convenience Methods (scoped to this session's address)
     */

    async getBalances(opts) {
        return this.sdk.getBalances(this.address, opts);
    }

    async getHistory(opts) {
        return this.sdk.getHistory(this.address, 'address', opts);
    }

    async getCredits(type, opts) {
        return this.sdk.getCredits(this.address, type || 'address', opts);
    }

    async getDebits(type, opts) {
        return this.sdk.getDebits(this.address, type || 'address', opts);
    }

    async getSends(opts) {
        return this.sdk.getSends(this.address, 'source', opts);
    }

    async getOrders(opts) {
        return this.sdk.getOrders(this.address, 'address', opts);
    }

    async getSwaps(opts) {
        return this.sdk.getSwaps(this.address, 'address', opts);
    }

    async getDispensers(opts) {
        return this.sdk.getDispensers(this.address, 'address', opts);
    }


    /*
     *  Fee estimation (scoped to this session's key/address)
     */

    async estimateFees(actionData, encoderOpts = {}) {
        let merged = {
            pubkey: this.address,      // sender ADDRESS (see submit())
            change: this.address,
            ...encoderOpts
        };
        return this.sdk.estimateFees(actionData, merged);
    }

}

module.exports = WalletSession;
