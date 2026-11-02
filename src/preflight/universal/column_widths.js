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
 * XChain Platform SDK - pre-flight universal checks: valid wire text wider than its column
 *
 ********************************************************************/

'use strict';

const { FINDING_CODES } = require('../constants.js');

/*
 * Wire fields whose format rules admit leading zeros, so a value the handler accepts can
 * be wider than the VARCHAR column its row stores it in. Before the indexer refused them,
 * such an action failed its INSERT and halted the block on every retry; it now refuses
 * each one from genesis, as the last rule on the field:
 *   PRICE v1 VALUE and FEE  prices.value and prices.fee, VARCHAR(250)
 *                           (xchain-indexer src/actions/price/v1.js PRICE_V1_TEXT_MAX_CHARS)
 *   BET 0 (create feed) FEE bet_feeds.fee, VARCHAR(11)
 *                           (xchain-indexer src/actions/bet/create_feed.js validateFeedTerms)
 * Widths are counted in code points, as the server and the indexer's exceedsCodePoints
 * count them. An empty field is absent and never measured.
 */
const COLUMN_TEXT_WIDTHS = Object.freeze({
    PRICE: { 1: Object.freeze({ VALUE: 250, FEE: 250 }) },
    BET:   { 0: Object.freeze({ FEE: 11 }) },
});

// Also run per BATCH sub-command, through checkHaltFields.
function checkColumnTextWidths(ctx, parsed) {
    const widths = (COLUMN_TEXT_WIDTHS[parsed.action] || {})[String(parsed.version)];
    if (!widths) return;
    ctx.markRun(FINDING_CODES.VALIDATOR_SEMANTICS);
    for (const field of Object.keys(widths)) {
        const raw = ctx.params[field];
        if (raw === undefined || raw === null || Array.isArray(raw)) continue;
        const width = Array.from(String(raw)).length;
        if (width <= widths[field]) continue;
        const verdict = `invalid: ${field} (length)`;
        ctx.addFinding(FINDING_CODES.VALIDATOR_SEMANTICS, 'error',
            `${field} is ${width} characters, wider than the ${widths[field]}-character column that stores it; `
            + `the indexer refuses this ${parsed.action} as ${verdict}, and an indexer without that rule can halt `
            + 'on it, so it must never be broadcast.',
            { field, width, limit: widths[field], verdict, haltClass: true });
    }
}

module.exports = { COLUMN_TEXT_WIDTHS, checkColumnTextWidths };
