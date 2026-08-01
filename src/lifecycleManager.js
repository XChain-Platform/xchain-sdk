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

const ActionWaiter = require('./actionWaiter.js');
const { SDKActionError, SDKConfigError } = require('./errors.js');


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
    //   strictStatus    - with requireValid, also refuse to ASSUME validity: reject
    //                     ACTION_STATUS_UNKNOWN when no indexer status could be read
    //                     for the action (default false; see actionWaiter, )
    //   explorer        - explorer client the indexer wait polls instead of the SDK's
    //   explorerUrl     - host/URL (with explorerPort) to build that client from;
    //                     for isolated stacks with no colocated explorer 
    //   onProgress      - callback(step, data) for lifecycle step notifications
    //
    // Returns: {
    //   txid, actionString, encoding, action (from indexer if waited),
    //   signed { txHex, txid, psbtHex }, spentInputs [{ txid, vout }]
    // }
    async submitAction(actionData, encoderOpts = {}, opts = {}) {
        let { wif, waitForIndexer, timeout, pollInterval, requireValid, strictStatus, onProgress,
              explorer, explorerUrl, explorerPort } = opts;
        if (!wif) throw new SDKConfigError('MISSING_WIF', 'submitAction requires opts.wif (WIF private key)');
        if (waitForIndexer === undefined) waitForIndexer = true;

        let encoder = this.sdk._requireEncoder();
        let progress = onProgress || (() => {});

        // Step 1: Create and validate action string. Compact ticker names AND
        // addresses to their `^<id>` wire form first (on by default; each
        // resolveActionParams returns the params unchanged when compaction is
        // disabled or an id can't be resolved).
        progress('creating', { action: actionData.action });
        let resolvedParams = await this.sdk.tickResolver.resolveActionParams(actionData.action, actionData.params);
        resolvedParams = await this.sdk.addressResolver.resolveActionParams(actionData.action, resolvedParams);
        let createResult = this.sdk.actions.createAction(Object.assign({}, actionData, { params: resolvedParams }));

        // Step 2: Encode to PSBT
        progress('encoding', { actionString: createResult.actionString });
        let txParams = {
            data:   createResult.actionString,
            pubkey: encoderOpts.pubkey
        };
        // Map optional encoder fields
        if (encoderOpts.change !== undefined)           txParams.change = encoderOpts.change;
        if (encoderOpts.utxos !== undefined)            txParams.utxos = encoderOpts.utxos;
        if (encoderOpts.rawData !== undefined)          txParams.rawData = encoderOpts.rawData;
        if (encoderOpts.encoding !== undefined)         txParams.encoding = encoderOpts.encoding;
        if (encoderOpts.fee !== undefined)              txParams.fee = encoderOpts.fee;
        if (encoderOpts.feePerKb !== undefined)         txParams.feePerKb = encoderOpts.feePerKb;
        if (encoderOpts.rbf !== undefined)              txParams.rbf = encoderOpts.rbf;
        if (encoderOpts.dust !== undefined)             txParams.dust = encoderOpts.dust;
        if (encoderOpts.unconfirmed !== undefined)      txParams.unconfirmed = encoderOpts.unconfirmed;
        if (encoderOpts.compressedPubKey !== undefined) txParams.compressedPubKey = encoderOpts.compressedPubKey;
        if (encoderOpts.customOutputs !== undefined)    txParams.customOutputs = encoderOpts.customOutputs;

        let encoded = await encoder.createTx(txParams);

        // Step 3: Sign the PSBT
        progress('signing', { encoding: encoded.encoding });
        let signed;
        if (typeof opts.signer === 'function') {
            // Custom signer (e.g. the MuSig2 co-signer): consumes the unsigned PSBT
            // and returns the same { txHex, txid, psbtHex } shape as signPsbt. It is
            // fail-closed - a policy denial or unenforceable shape throws here,
            // aborting before any broadcast. A two-phase P2SH/P2WSH large action
            // can't be completed through a custom signer (the co-signer reads only
            // the OP_RETURN carrier), so reject it up front rather than broadcast a
            // half-enforced phase 1.
            if (encoded.encoding === 'P2SH' || encoded.encoding === 'P2WSH')
                throw new SDKActionError('SIGNER_ENCODING_UNSUPPORTED',
                    `custom signer cannot complete ${encoded.encoding} two-phase encoding`);
            // : same reasoning for the Taproot envelope. Its reveal is a
            // BIP341 script-path spend over the envelope leaf, which a custom
            // signer that only reads the OP_RETURN carrier cannot produce. Refuse
            // BEFORE anything is broadcast rather than commit and then discover it.
            if (encoded.revealPsbt)
                throw new SDKActionError('SIGNER_ENCODING_UNSUPPORTED',
                    'custom signer cannot complete a TAPROOT envelope reveal (BIP341 script-path)');
            signed = await opts.signer(encoded.psbt, { encoding: encoded.encoding });
        } else {
            signed = this.sdk.wallet.signPsbt(encoded.psbt, wif);
        }

        // Step 3b ( §6 / ): a TAPROOT envelope comes back as a PAIR from
        // this one call, and the ordering rule is not a nicety: "the reveal must be
        // signable before the commit is broadcast; anything else manufactures a
        // stranded-funds event, not an error message". Broadcasting the commit first
        // and only then discovering the reveal cannot be signed leaves the coin in a
        // one-time P2TR output whose sole exit is the §3.5 key-path cancel. So sign
        // the reveal HERE, while nothing is on chain yet and a throw costs nothing.
        let revealSigned = null;
        if (encoded.revealPsbt) {
            revealSigned = this.sdk.wallet.signEnvelopeRevealPsbt(encoded.revealPsbt, wif);
            // §3.5 requires {commit outpoint, internal key, tapleaf hash} to be
            // durably persisted BEFORE the commit is broadcast, because the key-path
            // cancel cannot be reconstructed without them and the funds are then
            // stranded in an address nothing can re-derive. The SDK has no storage of
            // its own, so it hands the encoder's recovery record to the caller HERE,
            // at the last moment where nothing is on chain yet, and a caller that
            // persists on this event satisfies the rule.
            progress('envelope_recovery_record', { recovery: encoded.envelope || null });
        }

        // Step 4: Broadcast
        progress('broadcasting', { txid: signed.txid });
        await encoder.broadcastTx(signed.txHex);

        // Extract spent inputs from the signed PSBT for UTXO cache tracking
        let spentInputs = this._extractSpentInputs(encoded.psbt);

        // Step 4a: the envelope reveal, already signed above. The decoder indexes the
        // REVEAL, so its txid is the action's identity (§3.1), not the commit's.
        let finalTxidEnvelope = null;
        if (revealSigned) {
            progress('envelope_revealing', { commitTxid: signed.txid });
            try {
                await encoder.broadcastTx(revealSigned.txHex);
            } catch (err) {
                // The commit is already on chain and the reveal is not. This is the
                // one stranding path signing-first cannot remove, so it must never
                // surface as a bare network error: carry the §3.5 recovery record and
                // the signed reveal out with it, so the caller can retry the
                // broadcast or run create_envelope_cancel_tx. Losing this object is
                // losing the funds.
                throw new SDKActionError('ENVELOPE_REVEAL_BROADCAST_FAILED',
                    `commit ${signed.txid} is broadcast but the reveal was rejected: ${err && err.message ? err.message : err}. ` +
                    'Retry the reveal broadcast, or cancel the commit via the key path using the recovery record.',
                    { commitTxid: signed.txid, recovery: encoded.envelope || null,
                      revealTxHex: revealSigned.txHex, cause: err });
            }
            spentInputs = spentInputs.concat(this._extractSpentInputs(encoded.revealPsbt));
            finalTxidEnvelope = revealSigned.txid;
        }

        // Step 4b: Handle P2SH/P2WSH two-phase encoding
        // If the encoder chose P2SH or P2WSH, we need a second transaction to spend the output
        let finalTxid = signed.txid;
        if (encoded.encoding === 'P2SH' || encoded.encoding === 'P2WSH') {
            progress('p2sh_spending', { phase1Txid: signed.txid });

            // Phase 2 spends the P2SH/P2WSH output created by phase 1. The encoder
            // identifies that output from the phase-1 transaction itself, so p2shHash
            // is the broadcast phase-1 txid and p2shHex is its raw hex (the encoder's
            // create_tx response carries only { psbt, encoding }; there is no separate
            // hash field). Matches the connector flow in xchain-e2e-test transactionHelper.
            // customOutputs (e.g. the native-fee protocol-fee output) must ride
            // the reveal, because the indexer treats the reveal as the action and
            // reads the fee output from it. The encoder fences double-pay: for a
            // P2SH/P2WSH funding tx it funds these outputs into the P2SH outputs
            // WITHOUT emitting them, then emits them here on the reveal. So passing
            // the same customOutputs to both phases is correct, not a double charge.
            let spendResult = await encoder.spendP2sh({
                pubkey:           encoderOpts.pubkey,
                p2shHash:         signed.txid,
                p2shHex:          signed.txHex,
                data:             createResult.actionString,
                encoding:         encoded.encoding,
                rawData:          encoderOpts.rawData,
                compressedPubKey: encoderOpts.compressedPubKey,
                change:           encoderOpts.change,
                fee:              encoderOpts.fee,
                feePerKb:         encoderOpts.feePerKb,
                customOutputs:    encoderOpts.customOutputs
            });

            // Phase-2 inputs are non-standard P2SH/P2WSH reveal inputs; they need
            // the custom finalizer, not the default single-sig finalizeAllInputs.
            let spendSigned = this.sdk.wallet.signRevealPsbt(spendResult.psbt, wif);
            await encoder.broadcastTx(spendSigned.txHex);

            // Track phase 2 spent inputs
            let phase2Inputs = this._extractSpentInputs(spendResult.psbt);
            spentInputs = spentInputs.concat(phase2Inputs);

            // The indexer looks for the phase 2 transaction
            finalTxid = spendSigned.txid;
            signed = spendSigned;
        }
        if (finalTxidEnvelope) {                      // : the reveal IS the action
            finalTxid = finalTxidEnvelope;
            signed = revealSigned;
        }

        let result = {
            txid:         finalTxid,
            actionString: createResult.actionString,
            action:       createResult.action,
            version:      createResult.version,
            encoding:     encoded.encoding,
            signed:       signed,
            spentInputs:  spentInputs,
            indexed:      null
        };

        // Step 5: Wait for indexer confirmation
        if (waitForIndexer) {
            progress('waiting', { txid: finalTxid });
            // The explorer override rides through to the waiter so an isolated
            // venue is waited on where it is actually indexed, not on whatever
            // explorer hub discovery advertised .
            let waiter = new ActionWaiter(this.sdk);
            let indexed = await waiter.waitForTxid(finalTxid, {
                timeout:      timeout || 120000,
                pollInterval: pollInterval || 2000,
                requireValid: requireValid !== false,
                strictStatus: strictStatus === true,
                explorer:     explorer,
                explorerUrl:  explorerUrl,
                explorerPort: explorerPort
            });
            result.indexed = indexed;
            progress('confirmed', { txid: finalTxid, action: indexed });
        }

        return result;
    }

    // Extract input references from an unsigned PSBT hex for UTXO cache tracking
    _extractSpentInputs(psbtHex) {
        try {
            const bitcoin = require('bitcoinjs-lib');
            let psbt = bitcoin.Psbt.fromHex(psbtHex);
            return psbt.txInputs.map(input => ({
                txid: Buffer.from(input.hash).reverse().toString('hex'),
                vout: input.index
            }));
        } catch (e) {
            return [];
        }
    }

}

module.exports = LifecycleManager;
