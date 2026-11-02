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
 * XChain Platform SDK - Transaction Lifecycle Manager
 *
 * Orchestrates the full transaction pipeline:
 * create → encode → sign → broadcast → (P2SH phase 2) → wait for indexer
 *
 ********************************************************************/

const ActionWaiter = require('../utils/action_waiter.js');
const { installMethods } = require('../utils/install_methods.js');
const { assertMainnetLaunched } = require('../protocol/mainnet_launch.js');
const {
    buildTransactionRequest,
    normalizeSubmission,
    readCarriedAction,
    reconcileTransaction,
    validateCustomSigner,
} = require('./lifecycle_manager/submission_setup.js');
const {
    buildChunkRevealBroadcastError,
    buildEnvelopeBroadcastError,
    buildWaitOptions,
    finishEnvelope,
    finishPhase2,
    markBroadcastError,
    prepareEnvelope,
    prepareChunkReveal,
    shapeResult,
} = require('./lifecycle_manager/submission_results.js');

// Everything after the commit broadcast: the reveal, the result, the indexer
// wait and the contract gate. `sent` is kept current after each broadcast.
async function finishSubmission(manager, setup, actionData, opts, state) {
    const { encoder, progress, encoded, encoderOpts, createResult, carriedAction, revealSigned, phase2, sent } = state;
    let { signed } = state;
    let spentInputs = sent.spentInputs;
    let finalTxidEnvelope = null;
    if (revealSigned) {
        progress('envelope_revealing', { commitTxid: signed.txid });
        sent.pendingInputs = manager.extractSpentInputs(encoded.revealPsbt);
        try { await encoder.broadcastTx(revealSigned.txHex); }
        catch (error) { throw buildEnvelopeBroadcastError(error, signed, encoded, revealSigned); }
        ({ spentInputs, finalTxidEnvelope } = finishEnvelope(
            manager, encoded, revealSigned, spentInputs, sent.broadcastHexes));
        Object.assign(sent, { txid: finalTxidEnvelope, spentInputs, pendingInputs: [] });
    }
    let finalTxid = signed.txid;
    if (phase2) {
        sent.pendingInputs = manager.extractSpentInputs(phase2.spendResult.psbt);
        try { await encoder.broadcastTx(phase2.spendSigned.txHex); }
        catch (error) { throw buildChunkRevealBroadcastError(error, signed, phase2.spendSigned); }
        ({ finalTxid, signed, spentInputs } = finishPhase2(
            manager, phase2.spendResult, phase2.spendSigned, sent.broadcastHexes, spentInputs));
        Object.assign(sent, { txid: finalTxid, spentInputs, pendingInputs: [] });
    }
    const result = shapeResult(manager, {
        finalTxid, finalTxidEnvelope, revealSigned, signed, spentInputs, broadcastHexes: sent.broadcastHexes,
        encoderOpts, createResult, encoded, carriedActionString: carriedAction.carriedActionString,
    });
    finalTxid = result.txid;
    if (setup.waitForIndexer) {
        progress('waiting', { txid: finalTxid });
        const waiter = new ActionWaiter(manager.sdk);
        result.indexed = await waiter.waitForTxid(finalTxid, buildWaitOptions(setup));
        progress('confirmed', { txid: finalTxid, action: result.indexed });
    }
    if (opts.awaitContract) await manager.waitForContract(result, actionData, opts, progress, finalTxid);
    return result;
}

class LifecycleManager {

    constructor(sdk) {
        this.sdk = sdk;
    }

    // Submit an action through the full lifecycle.
    //
    // actionData   - { action, params } (same shape as createAction input, without encoder)
    // encoderOpts  - { pubkey, change, utxos, encoding, fee, feePerKb, ... }
    // opts:
    //   wif             - WIF private key for signing (required)
    //   waitForIndexer  - wait for indexer confirmation (default true)
    //   timeout         - ms to wait for indexer (default 120000)
    //   pollInterval    - ms between indexer polls (default 2000)
    //   requireValid    - reject if action status is 'invalid' (default true)
    //   strictStatus    - with requireValid, reject ACTION_STATUS_UNKNOWN when
    //                     no indexer status can be read. Defaults to false for
    //                     ordinary actions and true for contract actions.
    //   strictFreshness - refuse stale explorer data before encoding or signing
    //   awaitContract   - gate on contract state or balance before returning:
    //                       { contractActionIndex, key, equals, match,
    //                         tick, minQuantity, timeout, pollInterval }
    //                     Results land on result.contractState or
    //                     result.contractBalance.
    //   maxFeeSats      - absolute miner-fee ceiling for the encoder response
    //   maxPhaseFundingSats - absolute ceiling for shaped funding outputs
    //   explorer        - explorer client polled during the indexer wait
    //   explorerUrl     - explorer URL for constructing that client
    //   onProgress      - callback(step, data) for lifecycle notifications
    //
    // The reveal for either envelope or chunk encoding is built, reconciled and
    // signed before its commit is broadcast, so no commit goes out unless a reveal
    // this SDK will sign exists for it; a refusal there costs nothing. A reveal
    // broadcast error retains recovery information.
    //
    // Returns: {
    //   txid, actionString, encoding, action (from indexer if waited),
    //   signed { txHex, txid, psbtHex }, spentInputs [{ txid, vout }]
    // }
    async submitAction(actionData, encoderOpts = {}, opts = {}) {
        const setup = normalizeSubmission(this, actionData, opts);
        assertMainnetLaunched(this.sdk.network, actionData);
        const { encoder, progress, wif } = setup;
        if (opts.strictFreshness) await this.sdk.assertFresh();
        progress('creating', { action: actionData.action });
        let resolvedParams = await this.sdk.tickResolver.resolveActionParams(actionData.action, actionData.params);
        if (!opts.skipAddressCompaction)
            resolvedParams = await this.sdk.addressResolver.resolveActionParams(actionData.action, resolvedParams);
        const transaction = buildTransactionRequest(this, actionData, encoderOpts, resolvedParams, progress);
        const { createResult, txParams } = transaction;
        const encoded = await encoder.createTx(txParams);
        const carriedAction = readCarriedAction(encoded, createResult, encoderOpts);
        const reconcileState = reconcileTransaction(this, encoded, createResult, encoderOpts, opts);
        progress('signing', { encoding: encoded.encoding });
        let signed;
        if (typeof opts.signer === 'function') {
            validateCustomSigner(encoded);
            signed = await opts.signer(encoded.psbt, { encoding: encoded.encoding });
        } else signed = this.sdk.wallet.signPsbt(encoded.psbt, wif);
        const revealSigned = prepareEnvelope(this, { encoded, createResult, encoderOpts, wif, progress });
        const phase2 = await prepareChunkReveal(this, { encoder, signed, encoded, encoderOpts, carriedAction,
            reconcileState, createResult, wif, progress });
        progress('broadcasting', { txid: signed.txid });
        await encoder.broadcastTx(signed.txHex);
        // The commit is on the wire from here, so every later throw is tagged with
        // what was broadcast (markBroadcastError) instead of reading as a clean failure.
        const sent = {
            txid:           signed.txid,
            broadcastHexes: [signed.txHex],
            spentInputs:    this.extractSpentInputs(encoded.psbt),
            pendingInputs:  [],
            changeAddress:  encoderOpts.change || encoderOpts.pubkey,
        };
        try { return await finishSubmission(this, setup, actionData, opts, {
            encoder, progress, signed, encoded, encoderOpts, createResult, carriedAction, revealSigned, phase2, sent });
        } catch (error) { throw markBroadcastError(this, error, sent); }
    }

    // The contract an action targets, from its own params. Accepts the camelCase
    // form callers write and the upper-case wire form, so a params object built
    // either way gates on the right contract.
    static contractIndexOf(actionData) {
        let params = (actionData && actionData.params) || {};
        let index = params.contractActionIndex;
        if (index === undefined) index = params.CONTRACT_ACTION_INDEX;
        if (index === undefined) index = params.contract_action_index;
        return index;
    }

}

installMethods(LifecycleManager.prototype, require('./lifecycle_manager/settlement_reads.js'));

module.exports = LifecycleManager;
