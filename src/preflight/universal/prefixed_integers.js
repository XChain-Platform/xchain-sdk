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
 * XChain Platform SDK - pre-flight universal checks: hexadecimal, binary and octal
 * integer wire fields
 *
 ********************************************************************/

'use strict';

const { FINDING_CODES, EXPIRATION_MAX } = require('../constants.js');
const numeric = require('../numeric.js');

// config['INTEGER_FIELDS'] in xchain-indexer src/config/wire_fields.js: OUTCOME is INT
// UNSIGNED, every other field here BIGINT UNSIGNED (EXPIRATION_MAX is that u64 ceiling).
const OUTCOME_MAX = '4294967295';
const FIELD_MAX = Object.freeze({
    EXPIRATION: EXPIRATION_MAX, DEADLINE: EXPIRATION_MAX, REFUND_WINDOW: EXPIRATION_MAX,
    CALLBACK_BLOCK: EXPIRATION_MAX, OUTCOME: OUTCOME_MAX,
});

/*
 * Integer wire fields whose '0x10', '0b101' or '0o17' spelling passes the handler's
 * integer and range rules (which read it as a number) while the row writer binds the
 * wire text into an integer column, which a strict MariaDB session refuses. Every such
 * action halted the block whatever its verdict, so the indexer refuses each from genesis
 * as `invalid: <FIELD> (format)`, with util.keepsPrefixedSpelling:
 *   DISPENSER, ORDER, SWAP create and edit  EXPIRATION (dispenser/validate_format.js,
 *                                           order/validate.js, swap/validate.js)
 *   BET 0 (create feed)                     DEADLINE, REFUND_WINDOW (bet/create_feed.js)
 *   BET 2 (place) and 3 (resolve)           OUTCOME (bet/validate.js)
 *   ISSUE 0 and 4                           CALLBACK_BLOCK, only when it reads above
 *                                           zero, the case the tokens row binds as
 *                                           carried (issue/edit_rules.js)
 * A literal past the field's column range is normalized to NULL, which stores, so it
 * keeps its other verdicts; decimal spellings are never refused here.
 */
const PREFIXED_INTEGER_FIELDS = Object.freeze({
    DISPENSER: { 0: ['EXPIRATION'], 2: ['EXPIRATION'] },
    ORDER:     { 0: ['EXPIRATION'], 2: ['EXPIRATION'] },
    SWAP:      { 0: ['EXPIRATION'], 2: ['EXPIRATION'] },
    BET:       { 0: ['DEADLINE', 'REFUND_WINDOW'], 2: ['OUTCOME'], 3: ['OUTCOME'] },
    ISSUE:     { 0: ['CALLBACK_BLOCK'], 4: ['CALLBACK_BLOCK'] },
});
// A CALLBACK_BLOCK reading zero or below binds 0 in the tokens row, so the ISSUE stays valid.
const BOUND_ONLY_ABOVE_ZERO = new Set(['CALLBACK_BLOCK']);

function isRefusedSpelling(field, value) {
    if (!numeric.keepsPrefixedSpelling(value, FIELD_MAX[field])) return false;
    return !BOUND_ONLY_ABOVE_ZERO.has(field) || Number(value) > 0;
}

// Also run per BATCH sub-command, through checkHaltFields.
function checkPrefixedIntegers(ctx, parsed) {
    const fields = (PREFIXED_INTEGER_FIELDS[parsed.action] || {})[String(parsed.version)];
    if (!fields) return;
    ctx.markRun(FINDING_CODES.VALIDATOR_SEMANTICS);
    for (const field of fields) {
        const raw = ctx.params[field];
        if (raw === undefined || raw === null || Array.isArray(raw)) continue;
        const value = String(raw);
        if (!isRefusedSpelling(field, value)) continue;
        const verdict = `invalid: ${field} (format)`;
        ctx.addFinding(FINDING_CODES.VALIDATOR_SEMANTICS, 'error',
            `${field} (${value}) is a hexadecimal, binary or octal literal, which the integer column storing it `
            + `refuses; the indexer refuses this ${parsed.action} as ${verdict}, and an indexer without that rule `
            + 'can halt on it, so it must never be broadcast. Write the number in decimal digits.',
            { field, value, max: FIELD_MAX[field], verdict, haltClass: true });
    }
}

module.exports = { PREFIXED_INTEGER_FIELDS, FIELD_MAX, checkPrefixedIntegers };
