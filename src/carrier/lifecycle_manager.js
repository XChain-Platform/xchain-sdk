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
const {
    buildTransactionRequest,
    normalizeSubmission,
    readCarriedAction,
    reconcileTransaction,
    validateCustomSigner,
} = require('./lifecycle_manager/submission_setup.js');
const {
    buildEnvelopeBroadcastError,
    buildPhase2Request,
    buildWaitOptions,
    finishEnvelope,
    finishPhase2,
    markConfirmationTimeout,
    prepareEnvelope,
    preparePhase2,
    shapeResult,
} = require('./lifecycle_manager/submission_results.js');

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
    // The reveal for either envelope or chunk encoding is signed before its
    // corresponding broadcast. This ordering prevents an avoidable stranded
    // commit, while a reveal broadcast error retains recovery information.
    //
    // Returns: {
    //   txid, actionString, encoding, action (from indexer if waited),
    //   signed { txHex, txid, psbtHex }, spentInputs [{ txid, vout }]
    // }
    async submitAction(actionData, encoderOpts = {}, opts = {}) {
        const setup = normalizeSubmission(this, actionData, opts);
        const { encoder, progress, wif } = setup;
        if (opts.strictFreshness) await this.sdk.assertFresh();
        progress('creating', { action: actionData.action });
        let resolvedParams = await this.sdk.tickResolver.resolveActionParams(actionData.action, actionData.params);
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
        const revealSigned = prepareEnvelope(this, encoded, createResult, wif, progress);
        progress('broadcasting', { txid: signed.txid });
        await encoder.broadcastTx(signed.txHex);
        const broadcastHexes = [signed.txHex];
        let spentInputs = this._extractSpentInputs(encoded.psbt);
        let finalTxidEnvelope = null;
        if (revealSigned) {
            progress('envelope_revealing', { commitTxid: signed.txid });
            try { await encoder.broadcastTx(revealSigned.txHex); }
            catch (error) { throw buildEnvelopeBroadcastError(error, signed, encoded, revealSigned); }
            ({ spentInputs, finalTxidEnvelope } = finishEnvelope(
                this, encoded, revealSigned, spentInputs, broadcastHexes));
        }
        let finalTxid = signed.txid;
        if (encoded.encoding === 'P2SH' || encoded.encoding === 'P2WSH') {
            progress('p2sh_spending', { phase1Txid: signed.txid });
            const spendResult = await encoder.spendP2sh(
                buildPhase2Request(signed, encoded, encoderOpts, carriedAction));
            const spendSigned = preparePhase2(this, spendResult, reconcileState, createResult, wif);
            await encoder.broadcastTx(spendSigned.txHex);
            ({ finalTxid, signed, spentInputs } = finishPhase2(
                this, spendResult, spendSigned, broadcastHexes, spentInputs));
        }
        const result = shapeResult(this, {
            finalTxid, finalTxidEnvelope, revealSigned, signed, spentInputs, broadcastHexes,
            encoderOpts, createResult, encoded, carriedActionString: carriedAction.carriedActionString,
        });
        finalTxid = result.txid;
        if (setup.waitForIndexer) {
            progress('waiting', { txid: finalTxid });
            const waiter = new ActionWaiter(this.sdk);
            let indexed;
            try { indexed = await waiter.waitForTxid(finalTxid, buildWaitOptions(setup)); }
            catch (error) { markConfirmationTimeout(error, finalTxid); throw error; }
            result.indexed = indexed;
            progress('confirmed', { txid: finalTxid, action: indexed });
        }
        if (opts.awaitContract) await this._awaitContract(result, actionData, opts, progress, finalTxid);
        return result;
    }

    // The contract an action targets, from its own params. Accepts the camelCase
    // form callers write and the upper-case wire form, so a params object built
    // either way gates on the right contract.
    static _contractIndexOf(actionData) {
        let params = (actionData && actionData.params) || {};
        let index = params.contractActionIndex;
        if (index === undefined) index = params.CONTRACT_ACTION_INDEX;
        if (index === undefined) index = params.contract_action_index;
        return index;
    }

}

installMethods(LifecycleManager.prototype, require('./lifecycle_manager/settlement_reads.js'));

module.exports = LifecycleManager;
