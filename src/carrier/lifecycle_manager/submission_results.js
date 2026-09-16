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

const { SDKActionError } = require('../../utils/errors.js');
const { reconcileEncoded } = require('../reconcile_encoded.js');
const { assertCarrierBinding, assertEnvelopeCarrierBinding } = require('../bind_action_carrier.js');

// Sign an envelope reveal synchronously so it is ready before the commit broadcast.
function prepareEnvelope(manager, encoded, createResult, wif, progress) {
    let revealSigned = null;
    if (encoded.revealPsbt) {
        // The reveal is the first transaction carrying envelope action bytes, so
        // bind it while the commit remains unbroadcast and failure costs no funds.
        assertEnvelopeCarrierBinding({
            actionString: createResult.actionString,
            revealPsbt:   encoded.revealPsbt,
            network:      manager.reconcileNetwork(),
        });
        revealSigned = manager.sdk.wallet.signEnvelopeRevealPsbt(encoded.revealPsbt, wif);
        // Recovery material must be persisted before broadcasting the commit,
        // because the key-path cancel cannot be reconstructed without it.
        progress('envelope_recovery_record', { recovery: encoded.envelope || null });
    }
    return revealSigned;
}

// Preserve recovery details when an already-funded envelope reveal is rejected.
function buildEnvelopeBroadcastError(error, signed, encoded, revealSigned) {
    return new SDKActionError('ENVELOPE_REVEAL_BROADCAST_FAILED',
        `commit ${signed.txid} is broadcast but the reveal was rejected: ${error && error.message ? error.message : error}. ` +
        'Retry the reveal broadcast, or cancel the commit via the key path using the recovery record.',
        { commitTxid: signed.txid, recovery: encoded.envelope || null,
          revealTxHex: revealSigned.txHex, cause: error });
}

// Record a successful envelope reveal synchronously before choosing the final action txid.
function finishEnvelope(manager, encoded, revealSigned, spentInputs, broadcastHexes) {
    spentInputs = spentInputs.concat(manager.extractSpentInputs(encoded.revealPsbt));
    broadcastHexes.push(revealSigned.txHex);
    return { spentInputs, finalTxidEnvelope: revealSigned.txid };
}

// Build phase-2 arguments synchronously from the exact bytes committed by phase 1.
function buildPhase2Request(signed, encoded, encoderOpts, carriedAction) {
    // Chunk reveals must reproduce the stored payload exactly. Re-entering the
    // compression pass could produce a carrier that cannot spend the commit.
    return {
        pubkey:           encoderOpts.pubkey,
        p2shHash:         signed.txid,
        p2shHex:          signed.txHex,
        data:             carriedAction.carriedActionString,
        encoding:         encoded.encoding,
        rawData:          carriedAction.carriedRawData,
        ...(carriedAction.encoderCompressed ? { compress: false } : {}),
        compressedPubKey: encoderOpts.compressedPubKey,
        change:           encoderOpts.change,
        fee:              encoderOpts.fee,
        feePerKb:         encoderOpts.feePerKb,
        customOutputs:    encoderOpts.customOutputs
    };
}

// Reconcile, bind and sign phase 2 synchronously before its broadcast begins.
function preparePhase2(manager, spendResult, reconcileState, createResult, wif) {
    // The reveal must spend every shaped funding output from phase 1, which avoids
    // leaving undecodable carrier value under encoder control.
    reconcileEncoded(spendResult.psbt, Object.assign({}, reconcileState.reconcileIntent, {
        label: 'phase-2 reveal',
        requiredSpends: reconcileState.phase1.phaseFunding,
    }));

    // Phase-2 input scripts reveal the carrier committed by phase 1. This check
    // rejects an additional inline carrier without re-authorizing encoded bytes.
    assertCarrierBinding({
        psbt:         spendResult.psbt,
        actionString: createResult.actionString,
        network:      manager.reconcileNetwork(),
        label:        'phase-2 reveal',
    });

    // Non-standard P2SH and P2WSH inputs require the reveal-specific finalizer.
    return manager.sdk.wallet.signRevealPsbt(spendResult.psbt, wif);
}

// Update phase-2 tracking synchronously after its broadcast has succeeded.
function finishPhase2(manager, spendResult, spendSigned, broadcastHexes, spentInputs) {
    broadcastHexes.push(spendSigned.txHex);
    let phase2Inputs = manager.extractSpentInputs(spendResult.psbt);
    spentInputs = spentInputs.concat(phase2Inputs);
    return { finalTxid: spendSigned.txid, signed: spendSigned, spentInputs };
}

// Shape the public result synchronously after every transaction is broadcast.
function shapeResult(manager, state) {
    let { finalTxid, signed, spentInputs } = state;
    if (state.finalTxidEnvelope) {
        finalTxid = state.finalTxidEnvelope;
        signed = state.revealSigned;
    }

    // Return only change that survives all later phases, so a caller can safely
    // chain a new unconfirmed action from it.
    let spentSet = new Set(spentInputs.map(i => i.txid + ':' + i.vout));
    let changeAddress = state.encoderOpts.change || state.encoderOpts.pubkey;
    let changeOutputs = [];
    for (let hex of state.broadcastHexes) {
        for (let out of manager.extractChangeOutputs(hex, changeAddress)) {
            if (!spentSet.has(out.txid + ':' + out.vout)) changeOutputs.push(out);
        }
    }

    return {
        txid:          finalTxid,
        // Compression can change the indexed action string, so return the exact
        // carried form rather than the submitted authorization form.
        actionString:  state.carriedActionString,
        action:        state.createResult.action,
        version:       state.createResult.version,
        encoding:      state.encoded.encoding,
        signed:        signed,
        spentInputs:   spentInputs,
        changeOutputs: changeOutputs,
        indexed:       null
    };
}

// Build indexer wait options synchronously so default and override semantics stay centralized.
function buildWaitOptions(setup) {
    return {
        timeout:      setup.timeout || 120000,
        pollInterval: setup.pollInterval || 2000,
        requireValid: setup.requireValid !== false,
        strictStatus: setup.strictStatus === true,
        explorer:     setup.explorer,
        explorerUrl:  setup.explorerUrl,
        explorerPort: setup.explorerPort
    };
}

// Mark only confirmation timeouts as successful broadcasts that remain unindexed.
function markConfirmationTimeout(error, finalTxid) {
    if (error && error.code === 'CONFIRMATION_TIMEOUT'){
        error.broadcast = true;
        error.txid      = finalTxid;
        if (error.details && typeof error.details === 'object'){
            error.details.broadcast = true;
        }
    }
}

module.exports = {
    buildEnvelopeBroadcastError,
    buildPhase2Request,
    buildWaitOptions,
    finishEnvelope,
    finishPhase2,
    markConfirmationTimeout,
    prepareEnvelope,
    preparePhase2,
    shapeResult,
};
