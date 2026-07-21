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
 * XChain Platform SDK - Action Aliases (single in-repo source)
 *
 * Documented on-chain action aliases, expanded BEFORE any format
 * lookup. Keep in lockstep with xchain-decoder/src/XChainDecoder.js
 * ACTION_ALIASES, xchain-indexer/src/actions.js actionAliases, and
 * xchain-documentation/protocol/action-manifest.json "aliases": a
 * spec-following client may encode any of these leading tokens and
 * produce a valid on-chain payload. Lookup is case-sensitive, exactly
 * as the on-chain decoder performs it (no case-folding before the
 * alias/format lookup).
 *
 * The manifest-conformance unit test asserts this table is byte-equal
 * to the canonical manifest; every consumer in this repo must import
 * this table rather than carrying its own copy.
 *
 ********************************************************************/

'use strict';

const ACTION_ALIASES = Object.freeze({
    TRANSFER: 'SEND',
    ADDR:     'ADDRESS',
    DROP:     'AIRDROP',
    CAST:     'BROADCAST',
    MSG:      'MESSAGE',
});

module.exports = { ACTION_ALIASES };
