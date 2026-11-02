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

const EncoderClient = require('../../clients/encoder.js');
const { SDKActionError, SDKConfigError } = require('../../utils/errors.js');
const { reconcileEncoded, feeQuoteAuthorizedOutput } = require('../reconcile_encoded.js');
const { assertCarrierBinding, assertEnvelopeCommitBinding } = require('../bind_action_carrier.js');
const { ECPair } = require('../../utils/wallet/key_derivation.js');

const CONTRACT_ACTIONS = new Set(['DEPOSIT', 'EXECUTE', 'WITHDRAW']);

// Normalize submission controls synchronously so the asynchronous sequence stays visible at the entry point.
function normalizeSubmission(manager, actionData, opts) {
    let { wif, waitForIndexer, timeout, pollInterval, requireValid, strictStatus, onProgress,
          explorer, explorerUrl, explorerPort } = opts;
    if (!wif) throw new SDKConfigError('MISSING_WIF', 'submitAction requires opts.wif (WIF private key)');
    if (waitForIndexer === undefined) waitForIndexer = true;

    // A contract action defaults to fail-closed, while every other action keeps
    // the historical default.
    let contractAction = CONTRACT_ACTIONS.has(String(actionData && actionData.action).toUpperCase());
    if (strictStatus === undefined) strictStatus = contractAction;

    let encoder = manager.sdk.requireEncoder();
    let progress = onProgress || (() => {});
    return {
        wif, waitForIndexer, timeout, pollInterval, requireValid, strictStatus, explorer,
        explorerUrl, explorerPort, encoder, progress,
    };
}

// Build the createTx request synchronously after both resolver calls have completed.
function buildTransactionRequest(manager, actionData, encoderOpts, resolvedParams, progress) {
    let createResult = manager.sdk.actions.createAction(Object.assign({}, actionData, { params: resolvedParams }));

    progress('encoding', { actionString: createResult.actionString });
    let txParams = {
        data:   createResult.actionString,
        pubkey: encoderOpts.pubkey
    };
    // Map optional encoder fields through the shared list so createTx additions
    // such as feeQuote, compression options and sourceAddress are retained.
    EncoderClient.pickCreateTxOptions(encoderOpts, txParams);
    return { createResult, txParams };
}

// Select the bytes actually carried so compressed reveals reproduce the encoder output.
function readCarriedAction(encoded, createResult, encoderOpts) {
    // Transparent FILE compression rewrites the action string and deflates the
    // payload. The returned action and raw data therefore become authoritative
    // for result shaping and phase-2 construction, but not authorization.
    let carriedActionString = createResult.actionString;
    let carriedRawData = encoderOpts.rawData;
    const encoderCompressed = !!(encoded.compression && encoded.compression.compressed);
    if (encoderCompressed) {
        // Refuse before signing when an older encoder omits either byte string,
        // because the carrier cannot be checked or reproduced safely.
        if (typeof encoded.compression.data !== 'string' || !encoded.compression.data.length
            || typeof encoded.compression.rawData !== 'string')
            throw new SDKActionError('COMPRESSION_BYTES_UNREPORTED',
                'the encoder compressed the payload but did not report the action string and ' +
                'stored bytes it wrote, so neither the carrier gate nor the reveal can be built ' +
                'from them; refusing before anything is signed');
        carriedActionString = encoded.compression.data;
        carriedRawData = encoded.compression.rawData;
    }
    return { carriedActionString, carriedRawData, encoderCompressed };
}

// Re-derive the one caller-keyed commit output that the envelope reveal may spend.
function envelopeFundingFor(encoded, opts, network) {
    if (!encoded.revealPsbt) return null;
    let callerXOnly;
    try { callerXOnly = Buffer.from(ECPair.fromWIF(opts.wif, network).publicKey).subarray(1, 33); }
    catch (e) { throw new SDKActionError('ENVELOPE_COMMIT_MISMATCH', 'cannot derive the envelope caller key'); }
    return assertEnvelopeCommitBinding({
        commitPsbt: encoded.psbt, revealPsbt: encoded.revealPsbt, callerXOnly, network,
    });
}

// Bind the unsigned carrier to the caller-submitted bytes before signing begins.
function assertTransactionCarrier(manager, encoded, createResult, encoderOpts) {
    assertCarrierBinding({
        psbt:           encoded.psbt,
        actionString:   createResult.actionString,
        encoding:       encoded.encoding,
        carrierScripts: encoded.carrierScripts,
        callerIdentities: encoderOpts.pubkey,
        rawData:        encoderOpts.rawData == null ? null : encoderOpts.rawData,
        network:        manager.reconcileNetwork(),
        label:          'transaction',
    });
}

// Reconcile and bind the unsigned transaction before any signer can observe it.
function reconcileTransaction(manager, encoded, createResult, encoderOpts, opts) {
    // createTx is a remote response that chooses inputs, outputs and fees. The
    // structural gate validates that response against the submitted spend intent.
    // The hub feeQuote output is added by the encoder and is not listed in
    // customOutputs, so authorize it from the caller's own quote, as the fee
    // estimate gate does.
    const quoteOutput = feeQuoteAuthorizedOutput(encoderOpts.feeQuote);
    const withQuote = (outputs) => quoteOutput ? (outputs || []).concat([quoteOutput]) : outputs;
    const twoPhase = encoded.encoding === 'P2SH' || encoded.encoding === 'P2WSH';
    const network = manager.reconcileNetwork();
    const reconcileIntent = {
        network,
        customOutputs: encoderOpts.customOutputs,
        // A caller-provided change destination is submitted intent and must not
        // be mistaken for a shaped phase-funding output.
        changeAddresses: encoderOpts.change,
        // A reveal has no funding script of its own, so its default identity is
        // also an authorized change destination.
        callerIdentities: encoderOpts.pubkey,
        // Requested fees may be rounded to relay minimums, so only an explicit
        // maximum acts as a ceiling. The always-on burn guards still apply.
        // estimateFees and the message path read the ceiling from the encoder
        // options, so honor it here too instead of failing open; the submit
        // option wins when both are set.
        maxFeeSats:    opts.maxFeeSats != null ? opts.maxFeeSats : encoderOpts.maxFeeSats,
        // Phase-funding outputs count as output value rather than fees and need
        // their own optional ceiling.
        maxPhaseFundingSats: opts.maxPhaseFundingSats != null
            ? opts.maxPhaseFundingSats : encoderOpts.maxPhaseFundingSats,
    };
    const envelopeFunding = envelopeFundingFor(encoded, opts, network);
    const phase1 = reconcileEncoded(encoded.psbt, Object.assign({}, reconcileIntent, {
        label: 'transaction',
        // Phase-aware: a chunked P2SH/P2WSH action is indexed from its reveal, so
        // phase 1 only funds and emits no protocol-fee output; authorizing one
        // there would excuse an output the encoder must not add.
        customOutputs: twoPhase ? encoderOpts.customOutputs : withQuote(encoderOpts.customOutputs),
        phaseShapes: twoPhase ? ['p2sh', 'p2wsh']
            : (encoded.revealPsbt ? ['p2tr'] : []),
        // Only the caller-keyed output re-derived from the reveal may fund it.
        phaseSpends: envelopeFunding ? [envelopeFunding] : null,
    }));
    if (encoded.revealPsbt)
        reconcileEncoded(encoded.revealPsbt, Object.assign({}, reconcileIntent, {
            label: 'envelope reveal',
            customOutputs: withQuote(encoderOpts.customOutputs),
            requiredSpends: phase1.phaseFunding,
        }));

    // The structural gate deliberately does not interpret action bytes. Bind the
    // carrier to the caller-submitted string before either signing branch begins.
    // Reported compression bytes remain useful only for the reveal and result.
    assertTransactionCarrier(manager, encoded, createResult, encoderOpts);
    // A chunk reveal is the indexed transaction and carries the hub fee output, authorized by the quote.
    return { reconcileIntent, phase1, revealCustomOutputs: withQuote(encoderOpts.customOutputs) };
}

// Reject unsupported custom-signer shapes synchronously before any broadcast occurs.
function validateCustomSigner(encoded) {
    // Custom signers consume the unsigned PSBT and return the same signed shape.
    // Two-phase chunk transactions require a reveal finalizer that they do not run.
    if (encoded.encoding === 'P2SH' || encoded.encoding === 'P2WSH')
        throw new SDKActionError('SIGNER_ENCODING_UNSUPPORTED',
            `custom signer cannot complete ${encoded.encoding} two-phase encoding`);
    // Taproot envelope reveals are BIP341 script-path spends, which the custom
    // signer cannot produce after the commit has been broadcast.
    if (encoded.revealPsbt)
        throw new SDKActionError('SIGNER_ENCODING_UNSUPPORTED',
            'custom signer cannot complete a TAPROOT envelope reveal (BIP341 script-path)');
}

module.exports = {
    buildTransactionRequest,
    normalizeSubmission,
    readCarriedAction,
    reconcileTransaction,
    validateCustomSigner,
};
