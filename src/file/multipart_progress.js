'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const MULTIPART_PROGRESS_STEPS = Object.freeze([
    'planned',
    'funding_sent',
    'funding_confirmed',
    'wave_funded',
    'piece_sent',
    'piece_skipped',
    'manifest_sent',
    'wave_confirmed',
    'assembly_waiting',
    'complete',
]);

const KNOWN_STEPS = new Set(MULTIPART_PROGRESS_STEPS);

function makeProgressEmitter(onProgress, { totalPieces }) {
    let sent = 0;
    let skipped = 0;
    let callbackErrors = 0;

    function counts() {
        return { sent, skipped, totalPieces, callbackErrors };
    }

    function recordCallbackError() {
        callbackErrors += 1;
    }

    function emit(step, data = {}) {
        if (!KNOWN_STEPS.has(step)) throw new Error(`Unknown multipart progress step: ${step}`);
        if (step === 'piece_sent') sent += 1;
        if (step === 'piece_skipped') skipped += 1;
        if (typeof onProgress !== 'function') return;

        const payload = { ...data, sent, skipped, totalPieces };
        try {
            Promise.resolve(onProgress(step, payload)).catch(recordCallbackError);
        } catch {
            recordCallbackError();
        }
    }

    return { emit, counts };
}

module.exports = { MULTIPART_PROGRESS_STEPS, makeProgressEmitter };
