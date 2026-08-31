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
 **********************************************************************
 *
 * XChain - canonical TICK-reference field map
 *
 * The authoritative list of which ACTION params carry a value naming an
 * EXISTING token, and which of those the SDK may compact to the `^<id>` wire
 * form. It is the ticker twin of addressRefFields.js: the set is defined once
 * here and never restated at a call site, so it stays checkable against the
 * ACTION formats the field names come from.
 *
 * Two questions, deliberately separated, because a field can answer yes to the
 * first and no to the second:
 *
 *  - COMPACTABLE (TICK_REF_FIELDS): the SDK may rewrite the value to `^<id>`
 *    before serializing. The indexer accepts `^<id>` anywhere it accepts a
 *    ticker (db.js createTicker special-cases a leading `^` and resolves it
 *    through getTickerId), so the compacted form validates identically.
 *  - EXISTENCE-CHECKABLE (TICK_EXISTENCE_FIELDS): the value must name a token
 *    that already exists, so pre-flight can look it up and warn before the
 *    caller burns a transaction on a token the chain will not find.
 *
 * The defining TICK of an ISSUE is in neither role: a brand-new token has no id
 * to compact to, and its non-existence is the point. Both consumers special-case
 * ISSUE rather than the map doing it, because ISSUE.TICK shares its field NAME
 * with every other action's reference to an existing token.
 *
 * FILE.GATE_TICKER is existence-checkable but NEVER compactable
 * ------------------------------------------------------------
 * It looks eligible, and compacting it would validate. It would also silently
 * un-gate the file. The indexer stores the value VERBATIM into the
 * `gated_files.gate_ticker` VARCHAR column (db.js createGatedFile) and then
 * enforces gating with literal string equality against it:
 * `WHERE gf.gate_ticker = ?` in getGatedPackThresholds and in
 * getActiveGatedKeyHashes, both keyed by ticker NAME. Validation resolves the
 * caret (actions/file.js hands GATE_TICKER to getTokenInfo), so a compacted FILE
 * is accepted and stored as `^1234`, which no name-keyed lookup ever matches:
 * the pack's thresholds and key hashes vanish and the content stops being gated.
 * Two spellings of one token in a string-equality join is the hazard; the SDK's
 * job is not to create the second spelling.
 *
 * The existence half is worth keeping, and is the one behaviour this map adds:
 * actions/file.js rejects the ENTIRE FILE with `invalid: GATE_TICKER (unknown)`
 * when the token does not exist, and a FILE carries its payload, so the caller
 * loses a large transaction's fee to a typo pre-flight can catch.
 *
 ********************************************************************/

'use strict';

// Fields the SDK may compact to `^<id>`. Order is the wire-agnostic declaration
// order the pre-flight existence loop reports findings in; it is not sorted,
// because sorting would reorder findings for an action carrying two of them.
const TICK_REF_FIELDS = ['TICK', 'GIVE_TICK', 'GET_TICK', 'DIVIDEND_TICK', 'CALLBACK_TICK'];

// Fields that name an existing token but must NOT be compacted (see the
// GATE_TICKER note above). Held back from the resolver, kept in the pre-flight
// existence check.
const TICK_NO_COMPACT_FIELDS = ['GATE_TICKER'];

// Every field whose token existence is checkable: the union, compactable first
// so the existing finding order is unchanged.
const TICK_EXISTENCE_FIELDS = TICK_REF_FIELDS.concat(TICK_NO_COMPACT_FIELDS);

module.exports = { TICK_REF_FIELDS, TICK_NO_COMPACT_FIELDS, TICK_EXISTENCE_FIELDS };
