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

const { ACTION_ALIASES } = require('../../decoder/aliases.js');

// Per-ACTION caps, byte-equal to the indexer's UNGATED `actionLimits`
// (0 = forbidden inside a BATCH). FILE is deliberately ABSENT: its
// at-most-one rule is a client-side transport fact (one rawData payload per
// transaction), not an arbiter limit, and adding it here would make the
// conformance test compare the SDK against a table the indexer does not have.
//
// MINT's 1 is re-read at/after the flag as "1 per DISTINCT token" (D7), which
// is why the number stays here and only what it is COMPARED AGAINST moves.
const BATCH_ACTION_LIMITS = Object.freeze({
    BATCH: 0,
    MINT:  1,
    ISSUE: 1,
});

// Caps the arbiter merges over the table above at/after BATCH_ISSUANCE_LIMITS,
// byte-equal to the indexer's `gatedActionLimits` (D5). Kept as a SEPARATE
// table for the same reason the arbiter keeps one: DEPLOY is uncapped below
// the flag, and folding it into the ungated table would state a rule that
// never applied there.
const BATCH_GATED_ACTION_LIMITS = Object.freeze({
    DEPLOY: 1,
});

// What this mirror actually enforces (see the header: the post-flag rule set).
const BATCH_ACTION_LIMITS_ACTIVE = Object.freeze(
    Object.assign({}, BATCH_ACTION_LIMITS, BATCH_GATED_ACTION_LIMITS));

// Distinctness bucket for a MINT TICK carrying no positive evidence of a
// token. A Symbol for the arbiter's reason: it can never collide with a real
// key however a wire tick is spelled.
const UNRESOLVED_TICK_KEY = Symbol('BATCH_UNRESOLVED_TICK');

// Counting bucket for child (dotted-TICK) ISSUEs. Byte-equal to the indexer's
// `childIssueKey`; deliberately not a legal ACTION name so it can never
// collide with a BATCH_ACTION_LIMITS entry and child issuance stays uncapped.
const CHILD_ISSUE_KEY = 'ISSUE.CHILD';

// The three actions whose params take the implied legacy VERSION-0 injection
// (indexer batch.js normalizeSubAction).
const LEGACY_FORMAT_ACTIONS = ['ISSUE', 'MINT', 'SEND'];

// Mirror of xchain-indexer/src/utility.js isLegacyActionFormat: params[0] is
// either a VERSION or, in the pre-VERSION wire form, the TICK. A VERSION is at
// most two characters and numeric; anything else means the field is a TICK and
// the implied VERSION 0 has to be injected in front of it.
function isLegacyActionFormat(params) {
    const version = params[0];
    if (String(version).length > 2) return true;
    if (typeof version === 'string' && !(!isNaN(parseFloat(version)) && isFinite(version))) return true;
    return false;
}

// Alias rewrite, case-sensitive exactly as the arbiter performs it.
function expandAlias(action) {
    return Object.prototype.hasOwnProperty.call(ACTION_ALIASES, action)
        ? ACTION_ALIASES[action]
        : action;
}

module.exports = {
    BATCH_ACTION_LIMITS,
    BATCH_GATED_ACTION_LIMITS,
    BATCH_ACTION_LIMITS_ACTIVE,
    UNRESOLVED_TICK_KEY,
    CHILD_ISSUE_KEY,
    LEGACY_FORMAT_ACTIONS,
    isLegacyActionFormat,
    expandAlias,
};
