// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const {
    reconcileEncoded,
    psbtPrevouts,
    feeQuoteAuthorizedOutput,
} = require('./reconcile_encoded.js');
const { assertCarrierBinding, assertPhaseFundingBound } = require('./bind_action_carrier.js');
const { decodeActionStringFromPsbt } = require('../cosigner/psbt_action_decode.js');
const { SDKActionError } = require('../utils/errors.js');

// assertCarrierBinding accepts a transaction with no inline carrier, because
// some of its callers sign legs that legitimately carry none. A result offered
// as the requested action must positively carry it: a matched inline carrier,
// or chunk funding legs that assertPhaseFundingBound has bound to verified
// carrier scripts. Anything else would spend the caller's fee on nothing.
function assertActionCarried(encoded, reconciled, twoPhase, network, label) {
    const decoded = decodeActionStringFromPsbt(encoded.psbt, network ? { network } : {});
    if (decoded.ok) return;
    if (twoPhase && Array.isArray(reconciled.phaseFunding) && reconciled.phaseFunding.length) return;
    throw new SDKActionError('CARRIER_MISSING',
        `${label}: the transaction carries no copy of the action that was submitted`,
        { encoding: encoded.encoding, reason: decoded.reason });
}

function reconcileNetwork(sdk) {
    try { return sdk.wallet.getBitcoinNetwork(); }
    catch (error) { return undefined; }
}

function requestedOutputs(encoderOpts, customOutputs, twoPhase) {
    if (twoPhase) return [];
    const outputs = Array.isArray(customOutputs) ? customOutputs : [];
    const quoteOutput = feeQuoteAuthorizedOutput(encoderOpts.feeQuote);
    return quoteOutput ? outputs.concat([quoteOutput]) : outputs;
}

// Apply the common fail-closed gate before an encoder-authored PSBT is exposed
// as directly signable. Envelope callers may also provide the private reveal so
// both phases are reconciled while only the commit remains in the public result.
function reconcileSignableResult(sdk, encoded, actionString, encoderOpts, options = {}) {
    const network = reconcileNetwork(sdk);
    const revealPsbt = options.revealPsbt || null;
    const twoPhase = encoded.encoding === 'P2SH' || encoded.encoding === 'P2WSH';
    const intent = {
        network,
        changeAddresses: encoderOpts.change,
        callerIdentities: encoderOpts.pubkey,
        maxFeeSats: encoderOpts.maxFeeSats,
        maxPhaseFundingSats: encoderOpts.maxPhaseFundingSats,
    };
    const reconciled = reconcileEncoded(encoded.psbt, Object.assign({}, intent, {
        customOutputs: requestedOutputs(encoderOpts, options.customOutputs, twoPhase),
        label: options.label,
        phaseShapes: twoPhase ? ['p2sh', 'p2wsh'] : (revealPsbt ? ['p2tr'] : []),
        phaseSpends: revealPsbt ? (psbtPrevouts(revealPsbt) || []) : null,
    }));
    if (revealPsbt) {
        reconcileEncoded(revealPsbt, Object.assign({}, intent, {
            label: 'envelope reveal',
            customOutputs: [],
            requiredSpends: reconciled.phaseFunding,
        }));
    }
    assertCarrierBinding({
        psbt: encoded.psbt,
        actionString,
        encoding: encoded.encoding,
        carrierScripts: encoded.carrierScripts,
        callerIdentities: encoderOpts.pubkey,
        rawData: encoderOpts.rawData == null ? null : encoderOpts.rawData,
        network,
        label: options.label,
    });
    assertPhaseFundingBound({
        phaseFunding: reconciled.phaseFunding,
        carrierScripts: encoded.carrierScripts,
        encoding: encoded.encoding,
        network,
        label: options.label,
    });
    if (options.requireCarrier !== false)
        assertActionCarried(encoded, reconciled, twoPhase, network, options.label);
    return reconciled;
}

module.exports = { reconcileSignableResult };
