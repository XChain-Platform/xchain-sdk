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
 * XChain Platform SDK - Format Selector field names
 *
 * Reserved field names and prefixes the format selector parts share
 *
 ********************************************************************/

// VERSION is always auto-set by the SDK, never user-provided
const AUTO_FIELDS = ['VERSION'];

// Rest-field prefix: fields starting with '...' absorb variable-length array values
const REST_PREFIX = '...';

// Caller-facing field carrying the per-leg array of a repeated-field format
// (multi-destination SEND, multi-tick DESTROY/AIRDROP). Not a wire field: it
// expands positionally into the format's repeated group.
const LEGS_FIELD = 'LEGS';

// Versions auto-selection never builds. A SHARE or TRANSFER is permanent and
// fee-charging, so it is built only for a caller who names its VERSION. A
// { listActionIndex, memo } caller would otherwise fit format 5 with empty NAME
// and DESCRIPTION (`NAME (no change)`), while a { type, items } caller must keep
// format 0. versionCandidate only sees versions carried by formats.js, which has
// no LIST 4 or 5 yet, so current selections remain unchanged.
const PIN_ONLY_VERSIONS = Object.freeze({ LIST: Object.freeze([2, 3, 4, 5]) });

module.exports = { AUTO_FIELDS, PIN_ONLY_VERSIONS, REST_PREFIX, LEGS_FIELD };
