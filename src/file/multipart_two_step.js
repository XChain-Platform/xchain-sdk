/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

function invalid(field) {
    return new Error(`invalid ${field}`);
}

function definedCopy(value) {
    return Object.fromEntries(Object.entries(value || {}).filter(([, item]) => item !== undefined));
}

function validatedParams(params) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw invalid('params');
    if (params.encoding !== 'TAPROOT') throw invalid('encoding');
    if (Object.prototype.hasOwnProperty.call(params, 'p2shHash')) throw invalid('p2shHash');
    if (!params.pubkey) throw invalid('pubkey');
    if (!Array.isArray(params.utxos) || params.utxos.length === 0) throw invalid('utxos');
    return definedCopy(params);
}

function twoStepCommitParams(params) {
    const copy = validatedParams(params);
    copy.options = { ...definedCopy(params.options), twoStepEnvelope: true };
    return copy;
}

function twoStepRevealParams(params, signedCommitHex) {
    const copy = validatedParams(params);
    if (typeof signedCommitHex !== 'string' || signedCommitHex.length === 0 ||
        signedCommitHex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(signedCommitHex))
        throw invalid('signedCommitHex');
    const options = { envelopeCommitHex: signedCommitHex };
    if (params.options && params.options.signerSupportsTapscript !== undefined)
        options.signerSupportsTapscript = params.options.signerSupportsTapscript;
    copy.options = options;
    return copy;
}

function twoStepRecoveryRecord(revealResult) {
    const envelope = revealResult && revealResult.envelope;
    if (!envelope || !envelope.commitTxid) {
        const error = new Error('envelope commitTxid is missing');
        error.code = 'ENVELOPE_COMMIT_TXID_MISSING';
        throw error;
    }
    return envelope;
}

module.exports = { twoStepCommitParams, twoStepRevealParams, twoStepRecoveryRecord };
