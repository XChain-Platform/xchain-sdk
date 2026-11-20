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
const { nativeFeeQuoteSource } = require('./native_fee_source.js');
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
const { parse } = require('../decoder/parse.js');
const { checkHaltFields } = require('../preflight/universal/halt_fields.js');
const { REPORT_SCHEMA_VERSION } = require('../preflight/constants.js');
const { SDKPreflightError } = require('../utils/errors.js');

// Per-call values that leave the gate off: false, 'report' and 'local' match
// resolveMode's non-throwing modes. 'off' and 'warn' also skip this gate, though
// resolveMode reads them as enforce, so the gate can only pass more than the
// full pre-flight would, never less. Any other value enforces.
const NON_ENFORCING = new Set(['off', 'warn', 'report', 'local']);

function sameCustomOutput(a, b) {
    return a && b && a.address === b.address && String(a.value) === String(b.value);
}

// Quote against the exact composed bytes and merge the required native-coin fee
// output before the encoder can build or broadcast anything. Submit opts carry
// workflow-level overrides; direct callers can put the same override beside the
// encoder options used by estimateFees.
async function withNativeFeeOutputs(sdk, actionString, encoderOpts, opts) {
    if (typeof sdk.nativeFeeOutputs !== 'function') return encoderOpts;
    const nativeOpts = {
        source: nativeFeeQuoteSource(encoderOpts),
    };
    if (typeof opts.payFeeInNativeCoin === 'boolean')
        nativeOpts.payFeeInNativeCoin = opts.payFeeInNativeCoin;
    else if (typeof encoderOpts.payFeeInNativeCoin === 'boolean')
        nativeOpts.payFeeInNativeCoin = encoderOpts.payFeeInNativeCoin;
    const nativeOutputs = await sdk.nativeFeeOutputs(actionString, nativeOpts);
    if (!nativeOutputs.length) return encoderOpts;
    const customOutputs = Array.isArray(encoderOpts.customOutputs)
        ? encoderOpts.customOutputs.slice() : [];
    for (const output of nativeOutputs)
        if (!customOutputs.some(existing => sameCustomOutput(existing, output)))
            customOutputs.push(output);
    return Object.assign({}, encoderOpts, { customOutputs });
}

function enforcesHaltGate(sdk, preflightOpt) {
    if (preflightOpt === false || NON_ENFORCING.has(preflightOpt)) return false;
    if (preflightOpt !== undefined) return true;
    const sdkDefault = sdk && sdk._preflightMode;
    return sdkDefault === undefined || sdkDefault === 'enforce';
}

// Halt-class findings for one parsed action, and for each command when it is a BATCH.
function haltFindings(parsed) {
    const findings = [];
    const targets = Array.isArray(parsed.commands) ? parsed.commands : [parsed];
    targets.forEach((cmd, i) => {
        if (!cmd || !cmd.ok) return;
        const ctx = {
            params: cmd.params || {},
            markRun() {},
            addFinding(code, severity, message, data) {
                if (severity !== 'error' || !data || !data.haltClass) return;
                const finding = { code, severity, message, overridable: false, data };
                if (parsed.commands) finding.commandIndex = i;
                findings.push(finding);
            },
        };
        checkHaltFields(ctx, cmd);
    });
    return findings;
}

// The serialized-boundary gate every submit and BatchBuilder.build crosses before
// the encoder is contacted. It reads the composed wire string itself, not the
// params it came from, so a field the compose validator lets through in any
// spelling (a hexadecimal DEADLINE, an over-wide column, a missing STAKE key) is
// refused here on its wire form. These are the pre-flight findings the indexer
// refuses and an older indexer can halt on, so in enforce mode (the default) they
// throw SDKPreflightError with a pre-flight report, exactly as sdk.preflight would,
// and nothing reaches the encoder. Zero network: no Tier 1 dry run is made here.
function assertNoHaltClassFields(sdk, actionString, preflightOpt) {
    if (!enforcesHaltGate(sdk, preflightOpt)) return;
    if (typeof actionString !== 'string' || actionString === '') return;
    const parsed = parse(actionString);
    if (!parsed || !parsed.ok) return;
    const findings = haltFindings(parsed);
    if (!findings.length) return;
    const report = {
        schemaVersion: REPORT_SCHEMA_VERSION, verdict: 'fail', restricted: false,
        checksRun: [findings[0].code], findings, unverified: [], quote: null,
        stateHeight: null, elapsedMs: 0,
    };
    throw new SDKPreflightError('Pre-flight rejected this action before encoding: '
        + findings.map(f => (f.data && f.data.verdict) || f.code).join(', '), report);
}

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

function markPreBroadcastError(error) {
    if (!error || typeof error !== 'object') return error;
    error.preBroadcast = true;
    if (error.details && typeof error.details === 'object') error.details.preBroadcast = true;
    return error;
}

function markBroadcastUnknown(error, txid) {
    if (!error || typeof error !== 'object') return error;
    if (!error.details || typeof error.details !== 'object') error.details = {};
    error.details.txid = txid;
    error.details.broadcast = 'unknown';
    return error;
}

async function prepareSubmission(manager, actionData, encoderOpts, opts) {
    const setup = normalizeSubmission(manager, actionData, opts);
    assertMainnetLaunched(manager.sdk.network, actionData);
    const { encoder, progress, wif } = setup;
    if (opts.strictFreshness) await manager.sdk.assertFresh();
    progress('creating', { action: actionData.action });
    let resolvedParams = await manager.sdk.tickResolver.resolveActionParams(actionData.action, actionData.params);
    if (!opts.skipAddressCompaction)
        resolvedParams = await manager.sdk.addressResolver.resolveActionParams(actionData.action, resolvedParams);
    const { createResult, txParams } = buildTransactionRequest(
        manager, actionData, encoderOpts, resolvedParams, progress);
    assertNoHaltClassFields(manager.sdk, createResult.actionString, opts.preflight);
    encoderOpts = await withNativeFeeOutputs(manager.sdk, createResult.actionString, encoderOpts, opts);
    if (encoderOpts.customOutputs !== txParams.customOutputs) txParams.customOutputs = encoderOpts.customOutputs;
    const encoded = await encoder.createTx(txParams);
    const carriedAction = readCarriedAction(encoded, createResult, encoderOpts);
    const reconcileState = reconcileTransaction(manager, encoded, createResult, encoderOpts, opts);
    progress('signing', { encoding: encoded.encoding });
    let signed;
    if (typeof opts.signer === 'function') {
        validateCustomSigner(encoded);
        signed = await opts.signer(encoded.psbt, { encoding: encoded.encoding });
    } else signed = manager.sdk.wallet.signPsbt(encoded.psbt, wif);
    const revealSigned = prepareEnvelope(manager, { encoded, createResult, encoderOpts, wif, progress });
    const phase2 = await prepareChunkReveal(manager, { encoder, signed, encoded, encoderOpts, carriedAction,
        reconcileState, createResult, wif, progress });
    progress('broadcasting', { txid: signed.txid });
    return { setup, encoder, progress, signed, encoded, encoderOpts, createResult,
        carriedAction, revealSigned, phase2 };
}

class LifecycleManager {

    constructor(sdk) {
        this.sdk = sdk;
    }

    // Submit an action through the full lifecycle.
    //
    // actionData   - { action, params } (same shape as createAction input, without encoder)
    // encoderOpts  - { pubkey, change, utxos, rawData, encoding, fee, feePerKb,
    //                  rbf, dust, unconfirmed, compressedPubKey, customOutputs,
    //                  attachPrevTx, feeQuote, compress, options, sourceAddress,
    //                  maxFeeSats, maxPhaseFundingSats, payFeeInNativeCoin }
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
    //   skipAddressCompaction - keep action addresses in their supplied form
    //   payFeeInNativeCoin - override the connected chain's native-fee default
    //   preflight       - per-call halt-gate mode
    //   signer          - async (psbtHex, { encoding }) custom signer
    //   awaitContract   - gate on contract state or balance before returning:
    //                       { contractActionIndex, key, equals, match,
    //                         tick, minQuantity, timeout, pollInterval }
    //                     Results land on result.contractState or
    //                     result.contractBalance.
    //   maxFeeSats      - miner-fee ceiling applied to each transaction separately;
    //                     opts wins over encoderOpts
    //   maxPhaseFundingSats - local shaped-funding ceiling; opts wins over encoderOpts
    //   explorer        - explorer client polled during the indexer wait
    //   explorerUrl     - explorer URL for constructing that client
    //   explorerPort    - port paired with explorerUrl
    //   onProgress      - callback(step, data) for lifecycle notifications
    //
    // Caps are checked locally before signing, malformed values are refused, and
    // they are never sent to the encoder. maxFeeSats is not a running action total:
    // a commit and its reveal are each checked against it. estimateFees reads caps
    // only from encoderOpts, so put shared caps there.
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
        let state;
        try { state = await prepareSubmission(this, actionData, encoderOpts, opts); }
        catch (error) { throw markPreBroadcastError(error); }
        const { setup, encoder, progress, signed, encoded, createResult,
            carriedAction, revealSigned, phase2 } = state;
        encoderOpts = state.encoderOpts;
        try { await encoder.broadcastTx(signed.txHex); }
        catch (error) { throw markBroadcastUnknown(error, signed.txid); }
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

// Shared with BatchBuilder.build, which composes and can hand the encoder a PSBT request.
LifecycleManager.assertNoHaltClassFields = assertNoHaltClassFields;
LifecycleManager.markPreBroadcastError = markPreBroadcastError;

module.exports = LifecycleManager;
