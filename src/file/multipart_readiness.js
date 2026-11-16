// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const MEDIAN_TIME_SPAN = 11;

function medianTimePast(blockTimesNewestFirst) {
    if (!Array.isArray(blockTimesNewestFirst)) return null;

    const times = blockTimesNewestFirst
        .slice(0, MEDIAN_TIME_SPAN)
        .filter(time => Number.isFinite(time) && time > 0)
        .sort((a, b) => a - b);

    if (times.length === 0) return null;
    return times[Math.floor(times.length / 2)];
}

function assertMultipartActive(blockTimesNewestFirst, activationTime) {
    const median = medianTimePast(blockTimesNewestFirst);

    if (activationTime === null || activationTime === undefined ||
        median === null || median < activationTime) {
        const error = new Error('Multi-part files are not active');
        error.code = 'MULTIPART_NOT_ACTIVE';
        throw error;
    }

    return median;
}

module.exports = {
    medianTimePast,
    assertMultipartActive
};
