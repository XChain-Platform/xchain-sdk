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
 * XChain Platform SDK - BET (parimutuel betting) Helpers
 *
 * Pure builders for the four BET formats (see
 * xchain-documentation/protocol/actions/BET.md): v0 create a market, v1 cancel,
 * v2 place a bet, v3 resolve. Every rule mirrored here is a CONSENSUS rule the
 * indexer enforces; the point of duplicating them is that a malformed market
 * should fail in the caller's hands rather than after paying a fee to be
 * rejected on-chain. The SDK must never be stricter than consensus (that
 * refuses actions the protocol accepts) nor looser (that lets fees burn).
 *
 * The DETAILS schema lives here and is the single source of truth for it:
 * BET.md documents it, the wallet's create form is generated from it, and the
 * explorer renders against it. Only the shape rules the indexer actually checks
 * are enforced as errors (strict base64, size, JSON object, depth, and the
 * outcomes cross-check); every other key is convention and is validated only for
 * type, so a market carrying extra keys still composes.
 *
 * All pure: no network, no consensus. Submit-flow recipes live on
 * sdk.workflows (openMarket / placeBet / resolveMarket / cancelMarket); the raw
 * action wrapper is sdk.bet().
 *
 ********************************************************************/

const { SDKValidationError } = require('../../utils/errors.js');

// Consensus limits, mirrored from the indexer's BET config (xchain-indexer
// src/config.js) and documented in protocol/actions/BET.md. These are NOT in
// the vendored protocol/constants.js because they are action limits rather than
// consensus primitives, the same treatment MAX_TICK_LENGTH / MAX_MEMO_LENGTH
// get in validator.js. They must stay byte-equal with the indexer; the SDK
// being more permissive burns fees, being stricter blocks valid markets.
const BET_LIMITS = {
    MAX_BET_LABEL_LENGTH:      250,
    MAX_BET_OUTCOMES:          16,
    MAX_BET_OUTCOME_LENGTH:    64,
    MAX_FEED_FEE:              10,
    DEFAULT_BET_REFUND_WINDOW: 1209600,   // 14 days, Counterparty parity
    MIN_BET_REFUND_WINDOW:     3600,      // 1 hour
    MAX_BET_REFUND_WINDOW:     31536000,  // 1 year
    // DECODED bytes. DETAILS rides the wire base64-encoded (+33%) and the whole
    // ACTION string shares one 8192-byte compiled ceiling with LABEL, OUTCOMES,
    // TICK and MEMO, so this cannot be raised without re-deriving the worst-case
    // create. xchain-decoder/test/unit/bet_action_gate.test.js pins the arithmetic.
    MAX_BET_DETAILS_LENGTH:    4096,
    MAX_BET_DETAILS_DEPTH:     8,
    MAX_BETS_PER_FEED:         10000,
    MAX_BET_DEADLINE_HORIZON:  31536000   // 1 year past the block time
};

// Characters an outcome label may not contain: the OUTCOMES separator, the
// field separator, the BATCH command separator, and ASCII control characters
// (which render invisibly and would let two labels look identical). Spaces and
// ordinary punctuation are fine: "Kansas City Chiefs" is a normal label.
// eslint-disable-next-line no-control-regex
const OUTCOME_FORBIDDEN = /[,|;]|[\x00-\x1f\x7f]/;

// The DETAILS JSON schema. `required` and `type` are enforced by
// buildBetDetails; unknown keys are preserved untouched so a market can carry
// application-specific data the protocol never looks at.
const BET_DETAILS_SCHEMA = {
    title:               { type: 'string',   required: true,  maxLength: 250 },
    description:         { type: 'string',   required: false, maxLength: 2000 },
    outcomes:            { type: 'string[]', required: false },
    outcome_details:     { type: 'string[]', required: false },
    resolution_criteria: { type: 'string',   required: false, maxLength: 1000 },
    source:              { type: 'string',   required: false, maxLength: 500 },
    category:            { type: 'string',   required: false, maxLength: 64 }
};

function isSet(v) {
    return v !== undefined && v !== null && String(v).trim() !== '';
}

function fail(code, message, context) {
    throw new SDKValidationError(code, message, context || {});
}

// Nesting depth of a parsed JSON value. A scalar is depth 1, so a flat object
// is depth 2. Mirrors the indexer's walk, which is what MAX_BET_DETAILS_DEPTH
// bounds: the cap exists so the explorer renderer and this validator cannot be
// driven into deep recursion by attacker-chosen on-chain input.
function jsonDepth(value, depth = 1) {
    if (value === null || typeof value !== 'object') return depth;
    let max = depth;
    for (const key of Object.keys(value))
        max = Math.max(max, jsonDepth(value[key], depth + 1));
    return max;
}

module.exports = { BET_LIMITS, OUTCOME_FORBIDDEN, BET_DETAILS_SCHEMA, isSet, fail, jsonDepth };
