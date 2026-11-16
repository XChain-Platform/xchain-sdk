/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

function unsupportedSource(sourceType, reason) {
    const typeName = String(sourceType);
    const suffix = reason ? ': ' + reason : '';
    const error = new Error('Unsupported multipart source type "' + typeName + '"' + suffix);
    error.code = 'MULTIPART_SOURCE_UNSUPPORTED';
    throw error;
}

function multipartLaneFor({ taprootChain, sourceType } = {}) {
    if (typeof taprootChain !== 'boolean') {
        unsupportedSource(sourceType, 'taprootChain must be boolean');
    }

    if (taprootChain) {
        if (sourceType === 'p2wpkh' || sourceType === 'p2tr') {
            return { lane: 'envelope', buildMode: 'one_call' };
        }
        if (sourceType === 'p2pkh' || sourceType === 'p2sh-p2wpkh') {
            return { lane: 'envelope', buildMode: 'two_step' };
        }
        unsupportedSource(sourceType);
    }

    if (sourceType === 'p2pkh' || sourceType === 'p2wpkh' || sourceType === 'p2sh-p2wpkh') {
        return { lane: 'standard', buildMode: 'one_call' };
    }
    unsupportedSource(sourceType);
}

function twoStepEnvelopeOptions(phase, signedCommitHex) {
    if (phase === 'commit') {
        return { exactInputs: true, twoStepEnvelope: true };
    }
    if (phase !== 'reveal') {
        throw new Error('Unknown two-step envelope phase: ' + String(phase));
    }
    if (typeof signedCommitHex !== 'string' || signedCommitHex.length === 0 ||
        signedCommitHex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(signedCommitHex)) {
        throw new Error('signedCommitHex must be a non-empty, even-length hex string');
    }
    return { envelopeCommitHex: signedCommitHex };
}

module.exports = { multipartLaneFor, twoStepEnvelopeOptions };
