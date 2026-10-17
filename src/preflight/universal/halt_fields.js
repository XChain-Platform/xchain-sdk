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
 * XChain Platform SDK - pre-flight universal checks: wire fields that halt the indexer
 *
 ********************************************************************/

'use strict';

const { FINDING_CODES, EXPIRATION_MAX } = require('../constants.js');
const numeric = require('../numeric.js');
const Utility = require('../../utils/utility.js');

/*
 * Wire fields whose empty or unstorable value HALTS the indexer rather than refusing
 * the action. The normalize pass nulls a non-numeric NUMBER field and an INTEGER field
 * outside [0, U64_MAX] (xchain-indexer src/db/database/normalize.js:46-56, 71-74), the
 * handler then writes its row with that null in a NOT NULL column (dispenser_cancels /
 * dispenser_edits.dispenser_action_index, order_cancels / order_edits.order_action_index,
 * swap_cancels / swap_edits.swap_action_index, bets.feed_action_index,
 * stakes.signing_pubkey_id), and the block transaction throws and retries forever.
 * Measured on the off-rail conformance harness 2026-10-15 for every spelling below:
 * empty, negative, past U64_MAX and non-numeric. STAKE format 3 refuses a missing key
 * (src/actions/stake/contract_stake.js:95-96) and still halts on the same row write. The indexer fix that turns these
 * into refusals is separate; until every node runs it no wallet may broadcast one,
 * so each is a non-overridable refusal here, not a warning.
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
        const storable = value !== '' && util.isNumeric(value) && !numeric.exceedsUnsignedColumn(value, EXPIRATION_MAX);
        if (!storable) {
            ctx.addFinding(FINDING_CODES.VALIDATOR_SEMANTICS, 'error',
                `${indexField} ${value === '' ? 'is missing' : '(' + value + ') is not an action index the chain can store'}; `
                + 'the indexer nulls it and then halts writing this action\'s row, so it must never be broadcast.',
                { field: indexField, value, haltClass: true });
        }
    }
    if (requiredField) {
        const raw = ctx.params[requiredField];
        if (raw === undefined || raw === null || String(raw) === '') {
            ctx.addFinding(FINDING_CODES.VALIDATOR_SEMANTICS, 'error',
                `${requiredField} is missing; the indexer halts writing this action's row with no key, so it must `
                + 'never be broadcast.',
                { field: requiredField, value: '', haltClass: true });
        }
    }
}

module.exports = { HALT_INDEX_FIELDS, HALT_REQUIRED_FIELDS, checkHaltFields };
