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
 * XChain Platform SDK - pre-flight universal checks: unsafe action-row wire fields
 *
 ********************************************************************/

'use strict';

const { FINDING_CODES, EXPIRATION_MAX } = require('../constants.js');
const numeric = require('../numeric.js');
const Utility = require('../../utils/utility.js');

/*
 * Wire fields whose empty or unstorable value is refused by current indexer handlers.
 * Older nodes can instead normalize an invalid value to null and then halt while writing
 * a NOT NULL action-row column (dispenser_cancels / dispenser_edits.dispenser_action_index,
 * order_cancels / order_edits.order_action_index, swap_cancels / swap_edits.swap_action_index,
 * bets.feed_action_index, stakes.signing_pubkey_id). Current handlers refuse empty,
 * non-numeric, negative, past-U64_MAX and radix-prefixed index spellings before that write;
 * STAKE handlers likewise refuse a missing signing key. Until every node runs those
 * refusals no wallet may broadcast one, so each remains a non-overridable error here.
 */
const HALT_INDEX_FIELDS = Object.freeze({
    DISPENSER: { 1: 'DISPENSER_ACTION_INDEX', 2: 'DISPENSER_ACTION_INDEX' },
    ORDER:     { 1: 'ORDER_ACTION_INDEX', 2: 'ORDER_ACTION_INDEX' },
    SWAP:      { 1: 'SWAP_ACTION_INDEX', 2: 'SWAP_ACTION_INDEX' },
    BET:       { 2: 'FEED_ACTION_INDEX' },
});
const HALT_REQUIRED_FIELDS = Object.freeze({
    STAKE: { 1: 'SIGNING_PUBKEY', 2: 'SIGNING_PUBKEY', 3: 'SIGNING_PUBKEY' },
});
const UNSIGNED_COLUMN_RADIX_PREFIX = /^[-+]?0[xbo]/i;
const util = new Utility();

// Also run per BATCH sub-command (checks/batch.js), where `parsed` is the command.
function checkHaltFields(ctx, parsed) {
    const version = String(parsed.version);
    const indexField = (HALT_INDEX_FIELDS[parsed.action] || {})[version];
    const requiredField = (HALT_REQUIRED_FIELDS[parsed.action] || {})[version];
    if (!indexField && !requiredField) return;
    ctx.markRun(FINDING_CODES.VALIDATOR_SEMANTICS);
    if (indexField) {
        const raw = ctx.params[indexField];
        const value = raw === undefined || raw === null || Array.isArray(raw) ? '' : String(raw);
        // EXPIRATION_MAX is the U64_MAX string, the INTEGER_FIELDS bound of every index field here.
        // The prefix refusal mirrors storesAsNull: MariaDB does not accept JavaScript's
        // hexadecimal, binary or octal spellings when bound as strings to an integer column.
        const storable = value !== '' && !UNSIGNED_COLUMN_RADIX_PREFIX.test(value.trim())
            && util.isNumeric(value) && !numeric.exceedsUnsignedColumn(value, EXPIRATION_MAX);
        if (!storable) {
            ctx.addFinding(FINDING_CODES.VALIDATOR_SEMANTICS, 'error',
                `${indexField} ${value === '' ? 'is missing' : '(' + value + ') is not an action index the chain can store'}; `
                + 'current indexers refuse this action, and older indexers can halt while writing its row, '
                + 'so it must never be broadcast.',
                { field: indexField, value, haltClass: true });
        }
    }
    if (requiredField) {
        const raw = ctx.params[requiredField];
        if (raw === undefined || raw === null || String(raw) === '') {
            ctx.addFinding(FINDING_CODES.VALIDATOR_SEMANTICS, 'error',
                `${requiredField} is missing; current indexers refuse this action, and older indexers can halt `
                + 'while writing its row with no key, so it must never be broadcast.',
                { field: requiredField, value: '', haltClass: true });
        }
    }
}

module.exports = { HALT_INDEX_FIELDS, HALT_REQUIRED_FIELDS, checkHaltFields };
