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

module.exports = { AUTO_FIELDS, REST_PREFIX, LEGS_FIELD };
