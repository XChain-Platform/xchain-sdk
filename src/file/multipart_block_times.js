/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict';

function rowsOf(raw) {
    if (Array.isArray(raw)) return raw;
    if (raw && Array.isArray(raw.data)) return raw.data;
    return [];
}

function validateExplorer(explorer) {
    if (!explorer || typeof explorer.get !== 'function') {
        throw new Error('explorer must provide a get function');
    }
}

function validateCount(count) {
    if (!Number.isInteger(count) || count < 1 || count > 100) {
        throw new Error('count must be an integer from 1 to 100');
    }
}

function blockIndex(row) {
    const index = Number(row && row.block_index);
    return Number.isFinite(index) ? index : Number.NEGATIVE_INFINITY;
}

// The explorer's /blocks rows name the header time `timestamp`; `block_time` is
// kept for callers that hand in indexer-shaped rows.
function blockTime(row) {
    const raw = row && (row.block_time != null ? row.block_time : row.timestamp);
    const time = Number(raw);
    return Number.isFinite(time) && time > 0 ? time : null;
}

async function readRecentBlockTimes(explorer, count = 11) {
    validateExplorer(explorer);
    validateCount(count);
    const raw = await explorer.get('/blocks', { limit: count, sortorder: 'DESC' });
    return rowsOf(raw)
        .slice()
        .sort((a, b) => blockIndex(b) - blockIndex(a))
        .map(blockTime)
        .filter(time => time !== null)
        .slice(0, count);
}

module.exports = { readRecentBlockTimes };
