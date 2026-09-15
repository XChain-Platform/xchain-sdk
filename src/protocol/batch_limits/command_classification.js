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
 ********************************************************************/

'use strict';

const {
    CHILD_ISSUE_KEY,
    LEGACY_FORMAT_ACTIONS,
    isLegacyActionFormat,
    expandAlias,
} = require('./limit_tables.js');

// NOTE ON THE ACTIVATION SCAN, which this module deliberately does NOT mirror.
//
// The arbiter rejects a whole batch with `invalid: ACTION (unknown)` when any
// sub-command names something its `protocolChanges.isEnabled(action)` scan does
// not recognize (the empty string an empty command yields included), before any
// limit is counted. The client side answers that question in the DECODER, where
// each sub-command is parsed anyway: decoder/parse.js raises
// BATCH_COMMAND_INVALID with an UNKNOWN_ACTION / EMPTY code off the real parse
// attempt. This module deliberately exposes no second, narrower `formats`-keyed
// predicate: with the decoder answering the question for every caller, a
// third way to ask it would have no consumer outside a test.

/*
 * Classify one ISSUE TICK value.
 *
 * Returns CHILD_ISSUE_KEY only on positive evidence of a child issuance: a
 * TICK that exists, does not lead with '^', and contains a '.'. Everything
 * else counts against the top-level limit of 1.
 */
function classifyIssueTick(tick) {
    if (tick === undefined || tick === null) return 'ISSUE';
    const t = String(tick);
    if (t.charAt(0) === '^') return 'ISSUE';
    return t.includes('.') ? CHILD_ISSUE_KEY : 'ISSUE';
}

/*
 * FORMAT version of one raw wire field, mirroring the arbiter's ONE derivation
 * (xchain-indexer/src/utility.js `getFormatVersion`): the same call its
 * dispatcher uses to set FORMAT and its weight scan uses for the chunk-carrier
 * DEPLOY discount, reproduced branch for branch so the two sides can never
 * read one wire byte two ways. Quotes are stripped, a numeric string up to 255
 * parses as its integer, an absent or empty field means format 0, and
 * anything else (a float, an object, out of range, non-numeric) is null.
 */
function formatVersion(format) {
    const type = typeof format;
    // Reject objects (prevents crash on broken toString)
    if (type === 'object' && format !== null) return null;
    if (type === 'number' && Number.isInteger(format) && format <= 255) return format;
    // Default to format 0 if none is given
    if (type === 'undefined' || (type === 'string' && format === '')) return 0;
    // Strip out any quotes and double-quotes
    if (type === 'string') format = format.replace(/\"|\'/g, '');
    // Convert any numeric strings to integers (use parseFloat to detect
    // decimals), through the arbiter's own isNumeric/isFloat idioms.
    const numeric = typeof format === 'bigint' || (!isNaN(parseFloat(format)) && isFinite(format));
    const parsed = parseFloat(format);
    const isFloat = parsed === +parsed && parsed !== (parsed | 0);
    if (numeric && !isFloat && format <= 255) return parseInt(format);
    return null;
}

/*
 * Classify one RAW wire sub-command (`ACTION|VERSION|F1|...`, no BATCH prefix)
 * into the key the limit scan counts it under.
 *
 * Mirrors the arbiter's two-step read: the leading token is alias-expanded
 * (case-sensitively, never upper-cased), and only an ISSUE is looked at
 * further - on a PRIVATE split copy, because the legacy VERSION-0 injection
 * mutates the array in place. Never throws: an unreadable command falls back
 * to its unclassified name, which is the arbiter's own fallback.
 */
function classifyCommand(command) {
    const action = expandAlias(String(command).split('|')[0]);
    if (action !== 'ISSUE') return action;
    try {
        const params = String(command).split('|').slice(1);
        if (LEGACY_FORMAT_ACTIONS.includes(action) && isLegacyActionFormat(params))
            params.splice(0, 0, 0);
        return classifyIssueTick(params[1]);
    } catch (e) {
        return action;
    }
}

module.exports = {
    classifyIssueTick,
    formatVersion,
    classifyCommand,
};
