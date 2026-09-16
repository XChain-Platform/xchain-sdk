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
 * XChain Platform SDK - Policy Evaluation Checks
 *
 ********************************************************************/

'use strict';

const { ownLookup } = require('../policy/param_charset.js');
const valueDerivability = require('../policy/value_derivability.js');
const {
    pick, resolveValue, inCollection, capFor, resolveTickRef, hasNamedKey,
    formatCarriesDestination, gtDecimal, isNonNegativeDecimal, addDecimal,
    DESTINATION_KEYS, UNBOUNDED_VALUE_ACTIONS, UNRESOLVED_TICK_BUCKET,
} = require('./value_resolution.js');

function deny(code, message, details, evaluation) {
    return { ok: false, violation: { code, message, details: details || {} }, evaluation };
}

// Resolve action data once so every check uses the same normalized values.
function prepareEvaluation(policy, actionData) {
    const data    = actionData || {};
    const action  = String(data.action || '').toUpperCase();
    const params  = data.params || {};
    // Optional: present on the daemon path (decoded from the PSBT), absent on
    // the AgentSession path. Gates the value-derivability check below.
    const version = Number.isInteger(data.version) ? data.version : undefined;
    let { amount, tick } = resolveValue(action, params);
    const destRaw = pick(params, DESTINATION_KEYS);
    const destinations = destRaw === undefined ? []
        : Array.isArray(destRaw) ? destRaw : String(destRaw).split(';');

    // ^<id> wire-form tick references. The SDK compacts an indexed token's tick
    // to its immutable ^<id> form by default (tickResolver), and the co-signer
    // daemon evaluates the params it decodes FROM the PSBT, so the same token
    // reaches this check as either 'NAME' or '^123' depending on the wire form
    // the agent chose. Tick-identity-sensitive rules cannot bind a reference
    // they can't resolve: a named per-action cap would silently fall through to
    // the wildcard, and per-tick window accumulation (named or '*') would let
    // one token spend its window once per wire form. policy.tickIds
    // ({ NAME: id }) resolves the reference; without a resolution, identity-
    // sensitive policies fail closed rather than sign past a cap the operator
    // believes is enforced. (Wildcard-only per-action caps and count-only
    // window caps bind regardless of identity and are unaffected.)
    if (typeof tick === 'string' && tick.charAt(0) === '^') {
        const named = resolveTickRef(policy.tickIds, tick);
        if (named !== undefined) {
            tick = named;
        } else {
            const identitySensitive =
                (policy.maxPerAction && hasNamedKey(ownLookup(policy.maxPerAction, action))) ||
                !!(policy.maxPerWindow && policy.maxPerWindow.perTick) ||
                (policy.confirmAbove && hasNamedKey(policy.confirmAbove.perTick));
            if (identitySensitive)
                return { verdict: deny('POLICY_UNRESOLVED_TICK',
                    `${action} references token ${tick} by id, which this policy cannot resolve to a name; ` +
                    `tick-scoped limits cannot bind it (declare it in policy.tickIds, or submit with ` +
                    `compactTickers disabled)`,
                    { action, tick },
                    { action, tick, amount, destinations, needsConfirmation: false }) };
        }
    }
    return { action, params, version, amount, tick, destinations,
        evaluation: { action, tick, amount, destinations, needsConfirmation: false } };
}

// Apply amount, action, and destination checks before amount-cap classification.
function checkBasics(policy, state) {
    const { action, version, amount, tick, destinations, evaluation } = state;
    // Fail closed on non-canonical / negative amounts. Every amount gate below is
    // a magnitude comparison (gtDecimal) or a running sum (addDecimal): a negative
    // string sails past the per-action cap, LOWERS the projected window total, and
    // once recorded permanently poisons the velocity window. The amount is decoded
    // verbatim from the WIF holder's PSBT action string (psbt_action_decode.js) with
    // no numeric validation, so it is attacker-controlled and must be validated
    // here before any cap binds it. A canonical non-negative decimal only.
    if (amount !== undefined && !isNonNegativeDecimal(amount))
        return deny('POLICY_AMOUNT_INVALID',
            `${action} amount ${amount} is not a canonical non-negative decimal`,
            { action, tick, amount }, evaluation);

    if (!inCollection(policy.allowedActions, action))
        return deny('POLICY_ACTION_DENIED', `action ${action} is not in allowedActions`, { action }, evaluation);

    if (policy.allowedDestinations) {
        // G9: allowedDestinations binds only the action-string DESTINATION field,
        // and only 7 of the 68 decodable formats carry one (SEND v0, MINT v0,
        // MESSAGE v0-v3, SWEEP v0). The denominator is 68 with the bridge formats
        // (ISSUE v7, XBRIDGE v0/v1/v3/v4), while the numerator remains 7: an XBRIDGE
        // names its counterparty in DEST_ADDRESS / BTC_ADDRESS / ORIGIN_ADDRESS, none
        // of which is the DESTINATION field this list reads. Both halves are derived
        // from the shipped tables by the G9 conformance case in
        // test/unit/cosigner_hardening2.test.js, so this figure never needs hand-counting.
        // For every other format the destination list is
        // EMPTY and the membership loop below is vacuously satisfied - so every
        // trade, dispenser, contract-escrow, staking and native-pay action sailed
        // straight through a setting the operator reads as "this agent can only
        // ever move value to these addresses". Deny what the setting cannot
        // actually constrain, rather than passing it silently.
        //
        // Version-gated for the same reason as G2: DESTINATION is a property of the
        // (action, version) FORMAT, so the check needs the version the daemon
        // decodes from the PSBT. AgentSession, which usually has no version, keeps
        // today's behaviour; the co-signer is the authoritative gate.
        if (Number.isInteger(version) && version >= 0 && !formatCarriesDestination(action, version))
            return deny('POLICY_DESTINATION_UNENFORCEABLE',
                `${action} v${version} carries no DESTINATION field, so allowedDestinations cannot ` +
                `constrain where it moves value; it cannot be signed while allowedDestinations is set ` +
                `(remove the destination list, or disallow ${action})`,
                { action, version }, evaluation);
        for (const d of destinations)
            if (!inCollection(policy.allowedDestinations, d))
                return deny('POLICY_DESTINATION_DENIED',
                    `destination ${d} is not in allowedDestinations`, { action, destination: d }, evaluation);
    }
    return null;
}

// Reject formats whose value cannot satisfy the configured amount limits.
function checkDerivability(policy, state) {
    const { action, version, params, evaluation } = state;
    // Fail closed on actions whose outflow the policy cannot measure (see
    // UNBOUNDED_VALUE_ACTIONS) when any amount-based limit is configured. Without
    // this a SWEEP (whole-balance drain, no amount) or an AIRDROP/DIVIDEND (per-unit
    // amount x an off-chain set) would slip past every cap, since those checks are
    // guarded by `amount !== undefined` against a scalar that doesn't represent the
    // real total. A count-only maxActions is not an amount limit and does not trip this.
    const hasAmountLimit = !!policy.maxPerAction
        || !!(policy.maxPerWindow && policy.maxPerWindow.perTick)
        || !!policy.confirmAbove;

    if (UNBOUNDED_VALUE_ACTIONS.has(action) && hasAmountLimit)
        return deny('POLICY_UNBOUNDED_ACTION',
            `${action} moves an amount the policy cannot bound from the action alone; ` +
            `it cannot be signed while an amount cap is set (remove the amount cap or disallow ${action})`,
            { action }, evaluation);

    // G2: the general form of the guard above. The named set catches the three
    // actions that are unbounded by their very shape; this catches every OTHER
    // format whose outflow the evaluator cannot read - the index-reference
    // family (COINPAY/SWAP/ORDER/DISPENSER/BET/VOTE by ACTION_INDEX), the
    // ownership escape hatches on ORDER/SWAP/DISPENSER/ISSUE, and anything new
    // that nobody has classified yet. Before this, all of those resolved their
    // amount to undefined and every amount gate below silently SKIPPED, so the
    // operator's cap was decorative and no error said so.
    //
    // Only enforced when the version is known. The daemon always knows it (it
    // decodes the version from the PSBT and passes it, and refuses to sign
    // without one); AgentSession, the client-side guardrail, typically does not
    // - the encoder auto-selects the format after the policy check - and a
    // version-blind denial there would refuse ordinary multi-leg sends the
    // daemon path never sees. The co-signer is the authoritative gate, which is
    // exactly the split this spec draws between the two enforcement points.
    if (hasAmountLimit && Number.isInteger(version) && version >= 0) {
        const derivability = valueDerivability.classify(action, version, params);
        if (derivability.class === valueDerivability.UNBOUNDED)
            return deny('POLICY_UNBOUNDED_ACTION',
                derivability.blockedBy
                    ? `${action} v${version} sets ${derivability.blockedBy}, which moves value no amount cap can ` +
                      `express; it cannot be signed while an amount cap is set`
                    : `${action} v${version} moves an amount the policy cannot bound from the action alone ` +
                      `(it is defined by an on-chain object the co-signer cannot read); ` +
                      `it cannot be signed while an amount cap is set (remove the amount cap or disallow ${action})`,
                { action, version, blockedBy: derivability.blockedBy || undefined }, evaluation);
    }
    return null;
}

// Enforce the action-specific cap before projecting window usage.
function checkActionCap(policy, state) {
    const { action, amount, tick, evaluation } = state;
    if (policy.maxPerAction && amount !== undefined) {
        const cap = capFor(ownLookup(policy.maxPerAction, action), tick);
        if (cap !== undefined && gtDecimal(amount, cap))
            return deny('POLICY_AMOUNT_EXCEEDED',
                `${action} amount ${amount} exceeds per-action cap ${cap}${tick ? ' for ' + tick : ''}`,
                { action, tick, amount, cap }, evaluation);
    }
    return null;
}

// Project window counters and amounts without mutating the supplied snapshot.
function checkWindow(policy, state, windowUsage) {
    const { action, amount, tick, evaluation } = state;
    const win = policy.maxPerWindow;
    if (win) {
        const usage = windowUsage || { count: 0, perTick: {} };
        if (win.maxActions !== undefined && usage.count + 1 > win.maxActions)
            return deny('POLICY_WINDOW_COUNT_EXCEEDED',
                `window already holds ${usage.count} actions (max ${win.maxActions} per ${win.hours}h)`,
                { action, count: usage.count, maxActions: win.maxActions }, evaluation);
        // No `tick !== undefined` guard here: capFor falls through to the '*'
        // entry exactly like the maxPerAction and confirmAbove gates, so an
        // amount-bearing action whose tick did not resolve is still bound by a
        // wildcard window cap. Adding an extra tick guard would let such an action
        // bypass the only amount ceiling a wildcard-only policy expresses.
        //
        // G8: an unresolved tick reads its running total from a RESERVED BUCKET
        // that the stores accumulate such entries under. Treating the used total
        // as a hard-coded '0' would skip undefined-tick entries entirely, making
        // the projected total always `0 + amount` so a wildcard window cap binds
        // each transaction INDEPENDENTLY, forever. That is a per-transaction cap wearing a
        // window's name: COLLECT v0, UNSTAKE v0, capability STAKE before the gas
        // default applies, and anything future with an amount but no TICK could
        // repeat it without limit, bounded only by maxActions if set.
        if (win.perTick && amount !== undefined) {
            const cap = capFor(win.perTick, tick);
            if (cap !== undefined) {
                const bucket = tick !== undefined ? tick : UNRESOLVED_TICK_BUCKET;
                const used = ownLookup(usage.perTick, bucket) || '0';
                const projected = addDecimal(used, amount);
                if (gtDecimal(projected, cap))
                    return deny('POLICY_WINDOW_AMOUNT_EXCEEDED',
                        `${tick !== undefined ? tick : '(unresolved tick)'} window total would reach ${projected} (cap ${cap} per ${win.hours}h)`,
                        { action, tick, amount, windowTotal: used, cap }, evaluation);
            }
        }
    }
    return null;
}

// Mark advisory confirmation only after all denying checks pass.
function setConfirmation(policy, state) {
    const { amount, tick, evaluation } = state;
    if (policy.confirmAbove && amount !== undefined) {
        const threshold = capFor(policy.confirmAbove.perTick, tick);
        if (threshold !== undefined && gtDecimal(amount, threshold)) evaluation.needsConfirmation = true;
    }
}

/*
 * Evaluate an action against a spending policy.
 *
 * @param {object} policy   normalized policy
 * @param {object} actionData  { action, version?, params }
 * @param {object} [windowUsage]  current window snapshot
 * @returns {object} allow or deny verdict with normalized evaluation data
 */
function evaluatePolicy(policy, actionData, windowUsage) {
    const state = prepareEvaluation(policy, actionData);
    if (state.verdict) return state.verdict;

    let violation = checkBasics(policy, state);
    if (violation) return violation;
    violation = checkDerivability(policy, state);
    if (violation) return violation;
    violation = checkActionCap(policy, state);
    if (violation) return violation;
    violation = checkWindow(policy, state, windowUsage);
    if (violation) return violation;
    setConfirmation(policy, state);
    return { ok: true, violation: null, evaluation: state.evaluation };
}

module.exports = { evaluatePolicy };
