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

const Utility = require('../utility.js');

module.exports = {
    /*
     *  Action Convenience Methods
     *  Each wraps submit() with a fixed action name.
     */

    // Token lifecycle
    async send(params, enc, opts)      { return this.submit({ action: 'SEND', params }, enc, opts); },
    async issue(params, enc, opts)     { return this.submit({ action: 'ISSUE', params }, enc, opts); },
    async mint(params, enc, opts)      { return this.submit({ action: 'MINT', params }, enc, opts); },
    async destroy(params, enc, opts)   { return this.submit({ action: 'DESTROY', params }, enc, opts); },
    async transfer(params, enc, opts)  { return this.submit({ action: 'SEND', params }, enc, opts); },

    // Trading
    async order(params, enc, opts)     { return this.submit({ action: 'ORDER', params }, enc, opts); },
    async swap(params, enc, opts)      { return this.submit({ action: 'SWAP', params }, enc, opts); },
    async coinpay(params, enc, opts)   { return this.submit({ action: 'COINPAY', params }, enc, opts); },
    async dispenser(params, enc, opts) { return this.submit({ action: 'DISPENSER', params }, enc, opts); },

    // Distribution
    async dividend(params, enc, opts)  { return this.submit({ action: 'DIVIDEND', params }, enc, opts); },
    async airdrop(params, enc, opts)   { return this.submit({ action: 'AIRDROP', params }, enc, opts); },
    async sweep(params, enc, opts)     { return this.submit({ action: 'SWEEP', params }, enc, opts); },

    // Communication
    async broadcast(params, enc, opts) { return this.submit({ action: 'BROADCAST', params }, enc, opts); },
    async message(params, enc, opts)   { return this.submit({ action: 'MESSAGE', params }, enc, opts); },
    async file(params, enc, opts)      { return this.submit({ action: 'FILE', params }, enc, opts); },

    // Utility
    async list(params, enc, opts)      { return this.submit({ action: 'LIST', params }, enc, opts); },
    async link(params, enc, opts)      { return this.submit({ action: 'LINK', params }, enc, opts); },
    async callback(params, enc, opts)  { return this.submit({ action: 'CALLBACK', params }, enc, opts); },
    async sleep(params, enc, opts)     { return this.submit({ action: 'SLEEP', params }, enc, opts); },
    async address(params, enc, opts)   { return this.submit({ action: 'ADDRESS', params }, enc, opts); },

    // Oracle: permissionless user-run TOKEN/FIAT price (PRICE v1). Only v1 is
    // SDK-encodable (formats.js has no v0), so the encoder always selects it.
    // Params: { coin, tick, fiat, value, fee, memo }. See protocol/actions/PRICE.md.
    async price(params, enc, opts)     { return this.submit({ action: 'PRICE', params }, enc, opts); },

    // Governance: VOTE (create poll / cast ballot / delegate). Build params with
    // sdk.voting.*; the version rides in params.version. v2 (finalize) is
    // system-only. See protocol/actions/VOTE.md.
    async vote(params, enc, opts)      { return this.submit({ action: 'VOTE', params }, enc, opts); },

    // Betting: BET (create market / cancel / place bet / resolve). Build params
    // with sdk.betting.*; the version rides in params.version. See
    // protocol/actions/BET.md.
    async bet(params, enc, opts)       { return this.submit({ action: 'BET', params }, enc, opts); },

    // Capability (validator) staking. The indexer coin-gates these versions
    // to Bitcoin; the contract-targeted lane below is not gated.
    async stake(params, enc, opts)            { return this.submit({ action: 'STAKE', params }, enc, opts); },
    async unstake(params, enc, opts)          { return this.submit({ action: 'UNSTAKE', params }, enc, opts); },
    async delegate(params, enc, opts)         { return this.submit({ action: 'DELEGATE', params }, enc, opts); },
    async collect(params, enc, opts)          { return this.submit({ action: 'COLLECT', params }, enc, opts); },

    // Contract-targeted staking (any token, ANY CHAIN - STAKE v3 /
    // UNSTAKE v1 / DELEGATE v1 dispatch ahead of the indexer's BTC gate).
    // VERSION is forced by the helper (withForcedVersion, which throws rather
    // than route a caller-supplied version)
    // so callers can't accidentally route to capability staking. Pass
    // { AMOUNT, SIGNING_PUBKEY, TARGET_CONTRACT_INDEX, TICK } for stake;
    // { SIGNING_PUBKEY, TARGET_CONTRACT_INDEX, TICK } for unstake / delegate.
    async stakeToContract(params, enc, opts)     { return this.submit({ action: 'STAKE',    params: Utility.withForcedVersion('3', params) }, enc, opts); },
    async unstakeFromContract(params, enc, opts) { return this.submit({ action: 'UNSTAKE',  params: Utility.withForcedVersion('1', params) }, enc, opts); },
    async delegateForContract(params, enc, opts) { return this.submit({ action: 'DELEGATE', params: Utility.withForcedVersion('1', params) }, enc, opts); },

    // VM / Smart Contracts
    //
    // opts.preflight ('block' default | 'warn' | 'off') runs the contract-identity
    // check (CONTRACT_META_REQUIRED, spec 2.3) BEFORE anything is composed, signed or
    // broadcast: a contract the chain will reject for a missing or malformed `meta`
    // never costs a fee. Only a PROVEN failure refuses; computed meta advises.
    // sdk.deploy() has its own `lint` seam; this is the session's, and the two run the
    // same branch.
    async deploy(params, enc, opts)      {
        this.preflightContractMeta(params, opts);
        return this.submit({ action: 'DEPLOY', params }, enc, opts);
    },
    // One base64 code slice of a chunked deploy. DEPLOY v4 carrier (see sdk.deployContract / chunkHelper).
    // A carrier slice usually holds a fragment rather than a parseable module, which reads
    // undecidable and advises; the pre-flight bites on the assembling piece that does carry
    // the whole source, which is where the chain judges a chunked deploy too.
    async deployChunk(params, enc, opts) {
        this.preflightContractMeta(params, opts);
        return this.submit({ action: 'DEPLOY', params: Utility.withForcedVersion('4', params) }, enc, opts);
    },

    // Run the SDK's contract-identity pre-flight over a DEPLOY's params, before the
    // action is composed. The check lives on the SDK facade; a session built on a
    // stripped-down sdk object (the unit harnesses here, an embedding shell) has
    // nothing to run, and a deploy must not die on the absence of a client-side
    // courtesy check that only ever saves a fee. The refusal path itself is driven
    // against a real XChainSDK in test/unit/contract_meta_preflight.test.js, so a
    // renamed facade method fails there rather than silently disarming this.
    preflightContractMeta(params, opts) {
        let sdk = this.sdk;
        if (!sdk || typeof sdk.preflightContractMeta !== 'function'
                 || typeof sdk.contractSourceFromParams !== 'function') return;
        sdk.preflightContractMeta(sdk.contractSourceFromParams(params), (opts || {}).preflight);
    },
    async execute(params, enc, opts)   { return this.submit({ action: 'EXECUTE', params }, enc, opts); },
    async deposit(params, enc, opts)   { return this.submit({ action: 'DEPOSIT', params }, enc, opts); },
    async withdraw(params, enc, opts)  { return this.submit({ action: 'WITHDRAW', params }, enc, opts); },


    /*
     *  Explorer Convenience Methods (scoped to the bound address)
     */

    async getBalances(opts) {
        return this.sdk.getBalances(this.address, opts);
    },

    async getHistory(opts) {
        return this.sdk.getHistory(this.address, 'address', opts);
    },

    async getCredits(type, opts) {
        return this.sdk.getCredits(this.address, type || 'address', opts);
    },

    async getDebits(type, opts) {
        return this.sdk.getDebits(this.address, type || 'address', opts);
    },

    async getSends(opts) {
        return this.sdk.getSends(this.address, 'source', opts);
    },

    async getOrders(opts) {
        return this.sdk.getOrders(this.address, 'address', opts);
    },

    async getSwaps(opts) {
        return this.sdk.getSwaps(this.address, 'address', opts);
    },

    async getDispensers(opts) {
        return this.sdk.getDispensers(this.address, 'address', opts);
    },


    /*
     *  Fee estimation (scoped to the bound key/address)
     */

    async estimateFees(actionData, encoderOpts = {}) {
        let merged = {
            pubkey: this.address,      // sender ADDRESS (see submit())
            change: this.address,
            ...encoderOpts
        };
        return this.sdk.estimateFees(actionData, merged);
    }
};
