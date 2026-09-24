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

const chunkHelper = require('../../contract/chunk_helper.js');
const Utility = require('../../utils/utility.js');
const coins = require('../../coins');
const Config = require('../../config.js');

// Submit a bridge recipe, routing each half of the caller's opts to the layer
// that reads it. WalletSession.submit takes encoder options and submission
// options as SEPARATE arguments, so a recipe that hands its whole opts object
// to the third slot silently drops a feePerKb or an unconfirmed-input request:
// the encoder never sees them and the fee is whatever the default says. The
// `encoder` sub-object is lifted out and passed as the encoder argument; a
// caller who supplies no `encoder` key gets `{}` there, which is exactly the
// literal every recipe passed before, so nothing existing changes behaviour.
function submitBridge(workflows, wif, actionData, opts) {
    let submitOpts = { ...opts };
    let encoderOpts = submitOpts.encoder || {};
    delete submitOpts.encoder;

    let session = workflows.sdk.session(wif, submitOpts);
    return session.submit(actionData, encoderOpts, submitOpts);
}

module.exports = {
    // Open a market and immediately place the oracle's own opening context in a
    // single recipe is deliberately NOT offered: the oracle may not bet on its
    // own market (BET.md format 2), so such a helper could only ever produce a
    // rejected second transaction.

    /*
     * Cross-chain recipes from xchain-bridge.md and xchain-token-bridge.md. Every
     * one pins its wire VERSION through withForcedVersion:
     * the four user formats differ by ONE field each (v0 vs v3 by TICK, v1 vs v4 by
     * which address they carry), so auto-selection would be deciding which chain the
     * money leaves from, and a caller-supplied version that disagrees throws instead
     * of quietly re-routing.
     *
     * Each also validates its destination address against the COIN and NETWORK it
     * must land on, with the coin-aware validator ported into utility.js. This is the
     * one place the SDK cannot be loose: a lock is one-way, the federation signs what
     * the chain says, and a credit minted to an address nobody holds a key for is
     * gone. The indexer refuses the same address with 'invalid: DEST_ADDRESS', so the
     * check here only ever saves the sender a fee, never widens what the chain takes.
     */

    // Network the bridge helpers validate addresses against. An explicit
    // opts.network wins, then the SDK's configured network, then the environment.
    bridgeNetwork(opts = {}) {
        return opts.network || (this.sdk.options && this.sdk.options.network) || Config.env.network() || null;
    },

    // The Utility instance to validate with. Falls back to a fresh one so the
    // helpers work against the stub sdk their unit tests hand them.
    bridgeUtil() {
        return (this.sdk && this.sdk.util) ? this.sdk.util : new Utility();
    },

    // Normalize a caller's params to the UPPER_SNAKE wire names once, up front, so
    // these helpers read the same field a composed action would (camelCase in,
    // DEST_ADDRESS out) instead of guessing at the caller's spelling.
    bridgeParams(params) {
        return this.bridgeUtil().normalizeFields(params || {});
    },

    // Refuse an address that is not valid on the chain the value lands on.
    assertBridgeAddress(field, address, coin, network) {
        if (!network)
            throw new Error('XBRIDGE ' + field + ' cannot be checked without a network: pass opts.network or construct the SDK with one');
        if (!coin || !coins.ALLOWED_COINS.includes(String(coin).toUpperCase()))
            throw new Error('XBRIDGE ' + field + ' names an unsupported coin: ' + String(coin));
        if (!this.bridgeUtil().isCryptoAddress(address, String(coin).toUpperCase(), network))
            throw new Error('XBRIDGE ' + field + ' "' + String(address) + '" is not a valid ' + String(coin).toUpperCase()
                + ' ' + network + ' address. A bridge credit cannot be recalled, so the lock is refused here.');
    },

    // Lock XCHAIN on BTC for a credit on another chain (XBRIDGE v0, BTC only).
    //
    // wif    - WIF private key of the holder
    // params - { destCoin, destAddress, amount, memo }
    // opts   - submit options (network, waitForIndexer, timeout, maxFeeSats, ...)
    //          plus encoder: { feePerKb, unconfirmed, ... }
    //
    // Returns: <submitResult>
    async bridgeLock(wif, params, opts = {}) {
        let fields = this.bridgeParams(params);
        this.assertBridgeAddress('DEST_ADDRESS', fields.DEST_ADDRESS, fields.DEST_COIN, this.bridgeNetwork(opts));
        return submitBridge(this, wif,
            { action: 'XBRIDGE', params: Utility.withForcedVersion('0', fields) }, opts);
    },

    // Burn bridged XCHAIN off BTC to release the BTC escrow (XBRIDGE v1, never on BTC).
    //
    // params - { btcAddress, amount, memo }
    // opts   - as bridgeLock, including encoder: { feePerKb, unconfirmed, ... }
    async bridgeBurn(wif, params, opts = {}) {
        let fields = this.bridgeParams(params);
        this.assertBridgeAddress('BTC_ADDRESS', fields.BTC_ADDRESS, 'BTC', this.bridgeNetwork(opts));
        return submitBridge(this, wif,
            { action: 'XBRIDGE', params: Utility.withForcedVersion('1', fields) }, opts);
    },

    // Lock a general token on its origin chain (XBRIDGE v3).
    //
    // params - { tick, destCoin, destAddress, amount, memo }
    // opts   - as bridgeLock, including encoder: { feePerKb, unconfirmed, ... }
    //
    // TICK is the NATIVE name on this chain. A rooted name (BTC.FUFU) is the
    // bridged copy and is refused here rather than on chain, because v3 of a
    // bridged row is 'invalid: TICK (not native here)' and the fee is spent either
    // way. The dot rule is the same one the handler applies: milestone 1 bridges no
    // subassets, so any dotted native tick cannot be rooted on the destination.
    async bridgeTokenLock(wif, params, opts = {}) {
        let fields = this.bridgeParams(params);
        let tick   = String(fields.TICK === undefined || fields.TICK === null ? '' : fields.TICK);
        if (!tick)
            throw new Error('XBRIDGE v3 requires a TICK; use bridgeLock() for the gas token');
        if (tick.indexOf('.') !== -1)
            throw new Error('XBRIDGE v3 cannot bridge "' + tick + '": a dotted tick is a subasset or a bridged copy, and neither is bridgeable in this milestone');
        this.assertBridgeAddress('DEST_ADDRESS', fields.DEST_ADDRESS, fields.DEST_COIN, this.bridgeNetwork(opts));
        return submitBridge(this, wif,
            { action: 'XBRIDGE', params: Utility.withForcedVersion('3', fields) }, opts);
    },

    // Burn a bridged token row back to its origin chain (XBRIDGE v4).
    //
    // params - { tick, originAddress, amount, memo }
    // opts   - as bridgeLock, including encoder: { feePerKb, unconfirmed, ... }
    //
    // The origin chain is the tick's own root (BTC.FUFU burns back to BTC), so
    // ORIGIN_ADDRESS is validated against THAT chain and never against the chain
    // the burn is broadcast on. Reading it from the tick is also what makes a
    // wrong-chain address impossible to express.
    async bridgeTokenBurn(wif, params, opts = {}) {
        let fields = this.bridgeParams(params);
        let parsed = this.bridgeUtil().parseBridgedTick(fields.TICK);
        if (!parsed)
            throw new Error('XBRIDGE v4 needs a bridged tick of the form <ORIGIN>.<NAME>; got "' + String(fields.TICK) + '"');
        this.assertBridgeAddress('ORIGIN_ADDRESS', fields.ORIGIN_ADDRESS, parsed.origin, this.bridgeNetwork(opts));
        return submitBridge(this, wif,
            { action: 'XBRIDGE', params: Utility.withForcedVersion('4', fields) }, opts);
    },

    // Set a token's bridgeability (ISSUE format 7). Owner only, no issuance fee.
    //
    // params - { tick, bridgeChains, minDepth, lockBridge, memo }
    // opts   - as bridgeLock, including encoder: { feePerKb, unconfirmed, ... }
    //
    // bridgeChains is a comma list of destination coins, or the '-' sentinel for
    // none. An EMPTY field means UNCHANGED on chain, so an empty string is refused
    // here: a caller who means "close every door" must say '-', and a caller who
    // means "leave it alone" must omit the field.
    async setTokenBridgeability(wif, params, opts = {}) {
        let fields = this.bridgeParams(params);
        if (fields.BRIDGE_CHAINS !== undefined && fields.BRIDGE_CHAINS !== null && String(fields.BRIDGE_CHAINS) !== '-') {
            let chains = String(fields.BRIDGE_CHAINS).split(',').map(c => c.trim());
            if (!chains.length || chains.some(c => !c))
                throw new Error('ISSUE v7 BRIDGE_CHAINS must be a comma list of coins or the "-" sentinel; got "' + String(fields.BRIDGE_CHAINS) + '"');
            let allowed = coins.ALLOWED_COINS;
            for (let chain of chains)
                if (!allowed.includes(chain.toUpperCase()))
                    throw new Error('ISSUE v7 BRIDGE_CHAINS names an unsupported coin: ' + chain);
            fields.BRIDGE_CHAINS = chains.map(c => c.toUpperCase()).join(',');
        }
        return submitBridge(this, wif,
            { action: 'ISSUE', params: Utility.withForcedVersion('7', fields) }, opts);
    },

    // Throw unless the chunked deploy's Phase-2 assembler fits the compiled-action
    // cap. planDeploy sizes only the INLINE DEPLOY, so an oversized constructor
    // param (or staking field) survives planning and first surfaces at Phase 2,
    // after every paid v4 carrier is already broadcast and confirmed: the money is
    // gone and the contract can never assemble. Compose through the canonical
    // action-string core so the measurement cannot drift from what would actually
    // go on the wire, and gate on the same compiled-push quantity fitsSingleDeploy
    // uses (payload + OP_PUSHDATA2 prefix, exact in the 8192-byte neighbourhood).
    assertAssemblerFits(assembleParams) {
        let composed  = this.sdk.actions.composeActionString({ action: 'DEPLOY', params: Object.assign({}, assembleParams) });
        let compiled  = Buffer.byteLength(composed.actionString, 'utf8') + chunkHelper.OP_RETURN_PUSH_OVERHEAD;
        if (compiled > chunkHelper.MAX_ACTION_DATA_LENGTH)
            throw new Error('Chunked deploy assembling DEPLOY v' + composed.version + ' compiles to ' + compiled
                + ' bytes, exceeds MAX_ACTION_DATA_LENGTH (' + chunkHelper.MAX_ACTION_DATA_LENGTH
                + '). Shrink constructorParams. No carrier actions were broadcast.');
    },

    // Run a multi-step recipe whose steps broadcast independent, NON-atomic
    // transactions. `partial` is a mutable accumulator the worker fills in as each
    // step completes; on any throw (including a later step or a missing action_index),
    // the results already broadcast are attached to the error as `err.partial` so the
    // caller can reconcile instead of losing their txids. On success the worker's
    // return value (normally `partial` itself) is returned unchanged.
    async withPartial(partial, worker) {
        try {
            return await worker(partial);
        } catch (err) {
            if (err && typeof err === 'object' && err.partial === undefined) {
                try { err.partial = partial; } catch (e) { /* frozen/exotic error: leave it */ }
            }
            throw err;
        }
    },

    // Extract an action_index from a submitAction `indexed` result, tolerating both
    // shapes the waiter can resolve: a transaction ({ actions: [{ action_index }] })
    // on the polling path, or a single action ({ action_index }) on the WS path.
    actionIndexOf(indexed) {
        if (!indexed) return undefined;
        if (indexed.action_index !== undefined && indexed.action_index !== null) return indexed.action_index;
        if (Array.isArray(indexed.actions) && indexed.actions.length) return indexed.actions[0].action_index;
        return undefined;
    }
};
