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
 * XChain Platform SDK - Agent Policy Evaluator
 *
 * The pure, side-effect-free core of agent spending policy: given a
 * normalized policy, a decoded action, and a window-usage snapshot, it
 * returns a verdict (allow / deny / needs-confirmation). It does NO file
 * I/O, throws nothing for a denial (it returns a structured violation),
 * and fires no observers. Those side-effecting concerns live in the
 * caller.
 *
 * This is deliberately shared between two callers:
 *   - AgentSession (client-side guardrail): wraps the verdict with its
 *     own throw + onPolicyViolation observer + file-backed window store.
 *   - the MuSig2 co-signer daemon (hard enforcement): runs the SAME
 *     verdict server-side against its own window store, and withholds its
 *     partial signature when the verdict denies. One policy brain, two
 *     enforcement points, no drift.
 *
 ********************************************************************/

'use strict';

const { evaluatePolicy } = require('./policy_evaluator/evaluate_policy.js');
const valueDerivability = require('./policy/value_derivability.js');
const {
    pick,
    resolveValue,
    inCollection,
    capFor,
    hasEnforceableCap,
    resolveTickRef,
    formatCarriesDestination,
    gtDecimal,
    addDecimal,
    AMOUNT_KEYS,
    TICK_KEYS,
    DESTINATION_KEYS,
    GAS_TICK,
    ACTION_VALUE_FIELDS,
    UNBOUNDED_VALUE_ACTIONS,
    UNRESOLVED_TICK_BUCKET,
} = require('./policy_evaluator/value_resolution.js');

module.exports = {
    evaluatePolicy,
    // Exposed so AgentSession and the daemon share the exact same primitives.
    pick,
    capFor,
    hasEnforceableCap,
    inCollection,
    gtDecimal,
    addDecimal,
    AMOUNT_KEYS,
    TICK_KEYS,
    DESTINATION_KEYS,
    GAS_TICK,
    ACTION_VALUE_FIELDS,
    UNBOUNDED_VALUE_ACTIONS,
    resolveValue,
    resolveTickRef,
    valueDerivability,
    formatCarriesDestination,
    // Both window stores MUST accumulate unresolved-tick entries under this exact
    // key, or a wildcard window cap silently degrades to a per-transaction cap (G8).
    UNRESOLVED_TICK_BUCKET,
};
