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
 * Pre-flight Tier-2: ISSUE wire values wider than the issues column that stores them.
 *
 * Mirrors xchain-indexer src/actions/issue/token_state.js storedWidthError and the
 * MIN_DEPTH width rule in issue/bridge_opt_in.js. Every ISSUE writes its issues row from
 * the wire snapshot, whatever its verdict, so before those rules a value wider than its
 * VARCHAR column failed the INSERT and halted the block on every retry. The indexer now
 * refuses such an ISSUE from genesis, so each refusal here is a non-overridable error on
 * every plane and height.
 *
 ********************************************************************/

'use strict';

const { FINDING_CODES, EXPIRATION_MAX } = require('../../constants.js');
const numeric = require('../../numeric.js');
const Utility = require('../../../utils/utility.js');

const util = new Utility();

// The issues column widths the indexer checks (STORED_TEXT_WIDTHS in token_state.js).
const STORED_TEXT_WIDTHS = Object.freeze({
    DECIMALS:         2,
    CALLBACK_BLOCK:   15,
    MINT_START_BLOCK: 15,
    MINT_STOP_BLOCK:  15,
    BRIDGE_CHAINS:    250,
    LOCK_BRIDGE:      1,
});
// issues.min_depth is VARCHAR(15) (MIN_DEPTH_MAX_CHARS in bridge_opt_in.js).
const MIN_DEPTH_MAX_CHARS = 15;
const BLOCK_FIELDS = Object.freeze(['CALLBACK_BLOCK', 'MINT_START_BLOCK', 'MINT_STOP_BLOCK']);
// config.MIN_TOKEN_DECIMALS and MAX_TOKEN_DECIMALS (xchain-indexer src/config/token_limits.js).
const MIN_TOKEN_DECIMALS = 0;
const MAX_TOKEN_DECIMALS = 18;

// The text the indexer's normalizeDataValues leaves in a field, or null where it stores
// NULL. The indexer measures that value, not the wire text, so a DECIMALS of '019' (out of
// range, stored NULL) or a block field past the u64 ceiling is never a width refusal.
// BRIDGE_CHAINS and LOCK_BRIDGE are in no normalized field list and store as carried.
function storedText(name, value) {
    if (BLOCK_FIELDS.includes(name)) {
        if (!util.isNumeric(value) || numeric.exceedsUnsignedColumn(value, EXPIRATION_MAX)) return null;
    } else if (name === 'DECIMALS') {
        if (!util.isNumeric(value)) return null;
        if (Number(value) < MIN_TOKEN_DECIMALS || Number(value) > MAX_TOKEN_DECIMALS) return null;
    }
    return value;
}

function addWidthFinding(ctx, field, width, limit, verdict) {
    ctx.addFinding(FINDING_CODES.VALIDATOR_SEMANTICS, 'error',
        `${field} is ${width} characters, wider than the ${limit}-character column that stores it; `
        + `the indexer refuses this ISSUE as ${verdict}, and an indexer without that rule can halt on it, `
        + 'so it must never be broadcast.',
        { field, width, limit, verdict, haltClass: true });
}

// Every ISSUE format, on the wire fields it carries (empty means absent).
function checkIssueStoredWidths(ctx) {
    ctx.markRun(FINDING_CODES.VALIDATOR_SEMANTICS);
    for (const name of Object.keys(STORED_TEXT_WIDTHS)) {
        const raw = ctx.field(name);
        if (raw === '' || Array.isArray(raw)) continue;
        const stored = storedText(name, raw);
        if (stored === null) continue;
        const width = Array.from(stored).length;
        if (width > STORED_TEXT_WIDTHS[name])
            addWidthFinding(ctx, name, width, STORED_TEXT_WIDTHS[name], `invalid: ${name} (length)`);
    }
}

// ISSUE format 7 MIN_DEPTH: digit strings only reach this rule, and the indexer counts
// String.length, so UTF-16 length is the exact measure.
function checkMinDepthWidth(ctx) {
    const minDepth = ctx.field('MIN_DEPTH');
    if (!minDepth || Array.isArray(minDepth) || !/^\d+$/.test(minDepth)) return;
    if (minDepth.length > MIN_DEPTH_MAX_CHARS)
        addWidthFinding(ctx, 'MIN_DEPTH', minDepth.length, MIN_DEPTH_MAX_CHARS, 'invalid: MIN_DEPTH (format)');
}

module.exports = { MIN_DEPTH_MAX_CHARS, STORED_TEXT_WIDTHS, checkIssueStoredWidths, checkMinDepthWidth };
