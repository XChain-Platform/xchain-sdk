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
 * XChain Platform SDK - Validator
 *
 * Per-action input validation rules for all 30 ACTION types
 *
 ********************************************************************/

const FormatSelector = require('../format_selector.js');
const { ADDRESS_REF_FIELDS } = require('../../addressRefFields.js');


// Wording for the per-ACTION caps, keyed the way batchLimits keys them. The
// LIMITS stay in the shared mirror so a change lands once; only the sentence
// a caller reads lives here.
const BATCH_LIMIT_MESSAGES = {
    DEPLOY: 'BATCH can contain at most 1 DEPLOY action',
    MINT:   'BATCH can contain at most 1 MINT action per distinct TICK',
    ISSUE:  'BATCH can contain at most 1 top-level ISSUE action (child TICKs like JDOG.1 are exempt)',
};

// Caller-facing per-leg field of a repeated-field format (see format_selector.js)
const LEGS_FIELD = FormatSelector.LEGS_FIELD;

// Flat set of address-bearing wire fields (excludes type-gated LIST.ITEM, validated
// per list TYPE elsewhere). A ^<id> reference to an already-indexed address is valid
// anywhere a full address is; the indexer resolves it via getAddressId and the SDK
// address compactor (address_resolver.js) emits this form.
const ADDRESS_REF_FIELD_SET = (() => {
    const s = new Set();
    for (const a of Object.keys(ADDRESS_REF_FIELDS))
        for (const spec of ADDRESS_REF_FIELDS[a])
            if (!spec.listType) s.add(spec.field);
    return s;
})();

const MAX_SUPPLY_CEILING = 1000000000000000000000; // 1 sextillion
const MAX_DECIMALS       = 18;
const MAX_TICK_LENGTH    = 250;
const MAX_DESC_LENGTH    = 250;
const MAX_MESSAGE_LENGTH = 1048576; // 1MB

// PC-29: wire bound on FILE.GATE_MIN_AMOUNT. Matches the indexer's
// gated_files.gate_min_amount VARCHAR(40) exactly, and the reason it is a WIRE
// rule rather than only a column width is that consensus validity must never
// depend on what a DB does to an oversized value: if the column silently
// truncated, two nodes with different DB modes could disagree about the
// threshold. Rejecting at the format layer means the value that reaches storage
// always fits.
const MAX_GATE_MIN_AMOUNT_LENGTH = 40;
// 64KB contract source code limit. Must match the indexer (DEPLOY) and the VM
// isolate limit. Vendored single source of truth: ./protocol/constants.js, whose
// MAX_CODE_SIZE is in VALUE PARITY with (not a byte-identical copy of)
// xchain-documentation/protocol/constants.js, which is a superset file
// (uuid:0eb83c45); kept equal by test/unit/protocol_size_caps.test.js and the
// cross-service regression suite.
const MAX_CODE_SIZE      = require('../constants.js').MAX_CODE_SIZE;

// Allowed TICK characters: a-zA-Z0-9 and ~!@#$%^&*()_+-={}[]:<>.?
// Must stay an exact match for the indexer's TICK_CHARACTERS (xchain-indexer
// src/config.js); the SDK must never be more permissive than consensus.
// Forbidden: \ | ; . / (a leading ^ switches the value from a NAME to an id
// reference and is judged by validateIssueTickRef instead, never by this regex).
const TICK_REGEX = /^[a-zA-Z0-9~!@#$%^&*()_+\-={}[\]:<>.?]+$/;
// The caret that marks a wire value as an INDEX REFERENCE rather than a name.
const TICK_REF_PREFIX = '^';

// Characters forbidden in text fields (pipe = field separator, semicolon = command separator)
const FORBIDDEN_TEXT_CHARS = ['|', ';'];

// Default-deny delimiter guard. Every field value is serialized verbatim into
// the pipe-delimited action string (`ACTION|VERSION|F1|F2|...`), so NO field may
// carry the '|' field separator or the ';' BATCH command separator, or it
// corrupts the field layout (and ';' inside a BATCH injects a whole command).
// `checkDelimiters` enforces this on every field; the set below is the small,
// principled exemption list: BATCH COMMAND legitimately holds both delimiters,
// and the rest carry their own delimiter validation under a distinct error code
// (tick-name / GATE_TICKER / per-element PARAMS), so they opt out here to avoid
// double-reporting. An exemption is only ever as good as the validation it names:
// the ticker fields' own check covered ISSUE TICK and '^' ID references and left an
// ordinary non-ISSUE ticker name unvalidated, which is the injection validateFieldValue
// now closes at its third branch. Adding a field here means proving, at the branch
// that claims it, that every value shape reaches a delimiter check.
const DELIMITER_EXEMPT_FIELDS = new Set([
    'COMMAND',                                                          // BATCH sub-action carrier
    'TICK', 'GIVE_TICK', 'GET_TICK', 'DIVIDEND_TICK', 'CALLBACK_TICK',  // own tick-name validation
    'GATE_TICKER',                                                      // own |;./ check
    'CONSTRUCTOR_PARAMS', 'PARAMS',                                     // own per-element check
]);

// Valid FIAT currency codes. Must stay a byte-equal allow-list with the indexer's
// config['FIATS'] keys (xchain-indexer/src/config.js), which is the on-chain arbiter
// for PRICE FIAT_CODE. A subset here makes the SDK silently refuse a FIAT the protocol
// accepts (EUR/KRW were missing). Vendored single source of truth:
// ./protocol/constants.js (VALID_FIAT_CODES); the cross-service parity assertion in
// xchain-e2e-test/test/regression/protocol-size-limits.regression.js guards this.
const VALID_FIAT_CODES = [...require('../constants.js').VALID_FIAT_CODES];

// Valid coin identifiers (from the canonical coin registry).
const VALID_COINS = [...require('../../coins').ALLOWED_COINS];

// Required fields per action (minimum fields that must be present regardless of version)
const ACTION_REQUIRED_FIELDS = {
    ADDRESS:            [],
    AIRDROP:            ['TICK', 'AMOUNT', 'LIST_ACTION_INDEX'],
    BATCH:              ['COMMAND'],
    // BET v0 (create). The other three formats reference an existing market by
    // FEED_ACTION_INDEX and are exempted via ACTION_INDEX_FIELDS below.
    BET:                ['LABEL', 'OUTCOMES', 'TICK', 'DEADLINE'],
    BROADCAST:          [],
    CALLBACK:           ['TICK'],
    COINPAY:            ['ORDER_MATCH_ACTION_INDEX'],
    COLLECT:            [],
    DELEGATE:           [],
    // DEPLOY required fields are version-dependent (inline v0/v1 + assemble v2/v3 need
    // GAS_LIMIT; the v4 chunk carrier needs CODE_HASH/CHUNK_INDEX/TOTAL_CHUNKS/CODE_PART
    // but no GAS_LIMIT), so they are all enforced per-version in validateDeploy.
    DEPLOY:             [],
    DEPOSIT:            ['CONTRACT_ACTION_INDEX', 'TICK', 'QUANTITY'],
    DESTROY:            ['TICK', 'AMOUNT'],
    DISPENSER:          [],
    DIVIDEND:           ['TICK', 'DIVIDEND_TICK', 'AMOUNT'],
    EXECUTE:            ['CONTRACT_ACTION_INDEX', 'METHOD'],
    FILE:               ['NAME', 'TYPE'],
    ISSUE:              ['TICK'],
    LINK:               ['COIN1', 'COIN1_ACTION_INDEX', 'COIN2', 'COIN2_ACTION_INDEX'],
    LIST:               ['ITEM'],
    MESSAGE:            ['COIN', 'DESTINATION'],
    MINT:               ['TICK', 'AMOUNT'],
    ORDER:              [],
    PRICE:              ['COIN', 'TICK', 'FIAT', 'VALUE'],
    SEND:               ['TICK', 'AMOUNT', 'DESTINATION'],
    SLEEP:              ['RESUME_BLOCK'],
    STAKE:              ['AMOUNT', 'SIGNING_PUBKEY'],
    SWAP:               [],
    SWEEP:              ['DESTINATION'],
    UNSTAKE:            ['SIGNING_PUBKEY'],
    // VOTE anchors are version-split with no field common to all versions (v0 create
    // vs v1 ballot vs v3 delegate), so they are enforced per-version in validateVote.
    VOTE:               [],
    WITHDRAW:           ['CONTRACT_ACTION_INDEX', 'TICK', 'QUANTITY']
};

// Actions that have cancel/close/edit sub-operations via ACTION_INDEX reference
// For these, the base required fields don't apply when an action index field is present
const ACTION_INDEX_FIELDS = {
    BET:       'FEED_ACTION_INDEX',
    BROADCAST: 'BROADCAST_ACTION_INDEX',
    DISPENSER: 'DISPENSER_ACTION_INDEX',
    ORDER:     'ORDER_ACTION_INDEX',
    SWAP:      'SWAP_ACTION_INDEX'
};

module.exports = {
    BATCH_LIMIT_MESSAGES,
    LEGS_FIELD,
    ADDRESS_REF_FIELD_SET,
    MAX_SUPPLY_CEILING,
    MAX_DECIMALS,
    MAX_TICK_LENGTH,
    MAX_DESC_LENGTH,
    MAX_MESSAGE_LENGTH,
    MAX_GATE_MIN_AMOUNT_LENGTH,
    MAX_CODE_SIZE,
    TICK_REGEX,
    TICK_REF_PREFIX,
    FORBIDDEN_TEXT_CHARS,
    DELIMITER_EXEMPT_FIELDS,
    VALID_FIAT_CODES,
    VALID_COINS,
    ACTION_REQUIRED_FIELDS,
    ACTION_INDEX_FIELDS,
};
