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
    async submit(actionData, encoderOpts = {}, submitOpts = {}) {
        // Lazy-load UTXOs if cache is empty and no explicit UTXOs provided
        if (!encoderOpts.utxos && !this._utxoCache.isLoaded()) {
            await this.refreshUTXOs();
        }

        let utxos = this._utxoCache.getAvailable();

        let mergedEncoder = {
            pubkey: this.pubkey,
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

    // Staking (BTC-only)
    async stake(params, enc, opts)            { return this.submit({ action: 'STAKE', params }, enc, opts); }
    async unstake(params, enc, opts)          { return this.submit({ action: 'UNSTAKE', params }, enc, opts); }
    async delegate(params, enc, opts)         { return this.submit({ action: 'DELEGATE', params }, enc, opts); }
    async revokeDelegation(params, enc, opts) { return this.submit({ action: 'REVOKE_DELEGATION', params }, enc, opts); }
    async claimRewards(params, enc, opts)     { return this.submit({ action: 'CLAIM_REWARDS', params }, enc, opts); }

    // Contract-targeted staking (any token, BTC-only). VERSION is forced by the helper
    // so callers can't accidentally route to capability staking. Pass
    // { AMOUNT, SIGNING_PUBKEY, TARGET_CONTRACT_INDEX, TICK } for stake;
    // { SIGNING_PUBKEY, TARGET_CONTRACT_INDEX, TICK } for unstake / delegate.
    async stakeToContract(params, enc, opts)     { return this.submit({ action: 'STAKE',    params: { VERSION: '3', ...params } }, enc, opts); }
    async unstakeFromContract(params, enc, opts) { return this.submit({ action: 'UNSTAKE',  params: { VERSION: '1', ...params } }, enc, opts); }
    async delegateForContract(params, enc, opts) { return this.submit({ action: 'DELEGATE', params: { VERSION: '1', ...params } }, enc, opts); }

    // VM / Smart Contracts
    async deploy(params, enc, opts)    { return this.submit({ action: 'DEPLOY', params }, enc, opts); }
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
            pubkey: this.pubkey,
            change: this.address,
            ...encoderOpts
        };
        return this.sdk.estimateFees(actionData, merged);
    }

}

module.exports = WalletSession;
