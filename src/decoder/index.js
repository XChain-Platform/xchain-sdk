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
 * XChain Platform SDK - decoder (public barrel)
 *
 * First-class decode library (spec: claude/reports/
 * confirm-decode-preflight/SPEC.md §3). Two pure layers plus the PSBT
 * primitive:
 *
 *   parse(input, opts)        action string -> ParsedAction
 *   describe(parsed, ctx)     ParsedAction -> {summary, details, warnings}
 *   decodeActionFromPsbt(...) PSBT -> action (fail-closed; re-based on
 *                             parse(), external contract frozen)
 *
 * No network, no vault; safe for untrusted input.
 *
 ********************************************************************/

'use strict';

const { parse, BATCH_ACTION_LIMITS } = require('./parse.js');
const { describe } = require('./describe.js');
const { actionDisplayLabel } = require('./actionDisplayLabel.js');
const { ACTION_ALIASES } = require('./aliases.js');
const hardening = require('./hardening.js');
const { decodeActionFromPsbt, decodeActionStringFromPsbt } = require('../cosigner/psbtActionDecode.js');
// §5.3.2 companion to decodeActionFromPsbt: that one cross-checks an INLINE
// OP_RETURN action, this one covers the chunk lanes it fails closed on.
const { verifyCarrierScripts, REASONS: CARRIER_REASONS } = require('../carrier/verifyCarrierScripts.js');

module.exports = {
    parse,
    describe,
    decodeActionFromPsbt,
    decodeActionStringFromPsbt,
    verifyCarrierScripts,
    CARRIER_REASONS,
    actionDisplayLabel,
    ACTION_ALIASES,
    BATCH_ACTION_LIMITS,
    hardening,
};
