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

const { create, all } = require('mathjs');

const math = create(all, { number: 'BigNumber', precision: 64 });

// Param keys that carry value/routing across action types (camelCase and
// UPPER_SNAKE both appear at the session layer; createAction normalizes later).
const AMOUNT_KEYS      = ['amount', 'AMOUNT'];
const TICK_KEYS        = ['tick', 'TICK'];
const DESTINATION_KEYS = ['destination', 'DESTINATION', 'destinations', 'DESTINATIONS'];

// The protocol gas token. Capability STAKE (v1/v2) debits this token but carries
// no TICK field, so without this default a tick-scoped cap (maxPerAction.STAKE.XCHAIN)
// never binds and only the '*' wildcard applies. Mirrors the consensus value in
// xchain-indexer/src/config.js (config['GAS']); the canonical copy lives in
// xchain-documentation/protocol/constants.js and the cross-service drift guard in
// xchain-e2e-test asserts all three stay equal.
const GAS_TICK = 'XCHAIN';

// Per-action value/tick fields for actions whose primary outflow is NOT the
// generic amount/AMOUNT + tick/TICK pair. The cap must bind to what the signer
// GIVES AWAY, so the two-leg trade actions use the GIVE leg. Without this the
// amount pick returns undefined and every amount cap is silently skipped, leaving
// DEPOSIT / WITHDRAW / ORDER / SWAP / DISPENSER uncapped. (SEND / DESTROY / STAKE /
// MINT etc. carry AMOUNT and need no entry.)
const ACTION_VALUE_FIELDS = {
    DEPOSIT:   { amount: ['quantity', 'QUANTITY'],      tick: TICK_KEYS },
    WITHDRAW:  { amount: ['quantity', 'QUANTITY'],      tick: TICK_KEYS },
    ORDER:     { amount: ['giveAmount', 'GIVE_AMOUNT'], tick: ['giveTick', 'GIVE_TICK'] },
    SWAP:      { amount: ['giveAmount', 'GIVE_AMOUNT'], tick: ['giveTick', 'GIVE_TICK'] },
    DISPENSER: { amount: ['giveAmount', 'GIVE_AMOUNT'], tick: ['giveTick', 'GIVE_TICK'] },
    // Capability STAKE (v1/v2) stakes the gas token with no TICK field; default the
    // tick so gas-scoped caps bind. Contract-targeted STAKE v3 carries TICK, which
    // pick() prefers over the default.
    STAKE:     { amount: AMOUNT_KEYS, tick: TICK_KEYS, tickDefault: GAS_TICK },
};

// Actions whose value outflow the evaluator cannot bound from the action params
// alone: SWEEP transfers the ENTIRE balance (no amount field at all), and
// AIRDROP / DIVIDEND disburse amount x an off-chain recipient/holder set, so the
// per-unit AMOUNT under-counts the real total. When the operator has expressed any
// amount-limiting intent, the co-signer must refuse to sign these rather than let
// them slip past an unenforceable cap (a count-only maxActions is NOT an amount
// limit and still bounds them normally).
const UNBOUNDED_VALUE_ACTIONS = new Set(['SWEEP', 'AIRDROP', 'DIVIDEND']);

function pick(params, keys) {
    for (const k of keys)
        if (params && params[k] !== undefined && params[k] !== null && params[k] !== '')
            return params[k];
    return undefined;
}

// Resolve the (amount, tick) the caps should bind to for this action.
function resolveValue(action, params) {
    const spec = ACTION_VALUE_FIELDS[action];
    if (spec) {
        const tick = pick(params, spec.tick);
        return {
            amount: pick(params, spec.amount),
            tick:   tick !== undefined ? tick : spec.tickDefault,
        };
    }
    return { amount: pick(params, AMOUNT_KEYS), tick: pick(params, TICK_KEYS) };
}

// Membership test that accepts either a Set (AgentSession's normalized shape)
// or a plain Array (a daemon may hand us a policy straight off the wire).
function inCollection(collection, value) {
    if (!collection) return false;
    if (collection instanceof Set) return collection.has(value);
    if (Array.isArray(collection)) return collection.includes(value);
    return false;
}

function capFor(table, tick) {
    if (!table) return undefined;
    if (tick !== undefined && table[tick] !== undefined) return table[tick];
    return table['*'];
}

// Resolve a ^<id> wire-form tick reference to its name via the policy's
// declared { NAME: id } map. Deterministic and offline: the daemon must not
// depend on (or trust) an explorer lookup to decide what it signs.
function resolveTickRef(tickIds, tick) {
    if (!tickIds) return undefined;
    const id = String(tick).slice(1);
    for (const name of Object.keys(tickIds))
        if (String(tickIds[name]) === id) return name;
    return undefined;
}

function hasNamedKey(table) {
    return !!table && Object.keys(table).some((k) => k !== '*');
}

// Exact decimal comparison via BigNumber methods. mathjs larger()/equal()
// apply an epsilon tolerance, which is exactly wrong for policy caps.
function gtDecimal(a, b) { return math.bignumber(String(a)).gt(math.bignumber(String(b))); }
// Canonical non-negative decimal: digits, optional single fractional part. No
// sign, no exponent, no whitespace, no hex. Rejects '-1', '+5', '1e5', '0x10',
// ' 5', '5.', '', so a magnitude/sum gate can never be bypassed by a malformed
// amount decoded off the wire.
function isNonNegativeDecimal(a) { return /^\d+(\.\d+)?$/.test(String(a)); }
function addDecimal(a, b) { return math.bignumber(String(a)).plus(math.bignumber(String(b))).toString(); }

function deny(code, message, details, evaluation) {
    return { ok: false, violation: { code, message, details: details || {} }, evaluation };
}

/*
 * Evaluate an action against a spending policy.
 *
 * @param {object} policy   normalized policy:
 *   {
 *     allowedActions:      Set|Array of UPPERCASE action names (required),
 *     allowedDestinations: Set|Array|null,
 *     maxPerAction:        { ACTION: { TICK|'*': capString } } | null,
 *     maxPerWindow:        { hours, maxActions?, perTick?: { TICK|'*': capString } } | null,
 *     confirmAbove:        { perTick: { TICK|'*': thresholdString } } | null,
 *     tickIds:             { TICK: numericId } | null   (resolves ^<id> wire-form tick references),
 *   }
 * @param {object} actionData  { action, params } (params may use camelCase or UPPER_SNAKE)
 * @param {object} [windowUsage]  current window snapshot, REQUIRED when policy.maxPerWindow is set:
 *   { count:number, perTick:{ TICK: totalString } }
 * @returns {object} verdict:
 *   { ok:true,  violation:null, evaluation }   on allow
 *   { ok:false, violation:{code,message,details}, evaluation }  on deny
 *   evaluation = { action, tick, amount, destinations, needsConfirmation }
 *
 * needsConfirmation is advisory: the caller runs the confirmAbove handler.
 */
function evaluatePolicy(policy, actionData, windowUsage) {
    const data    = actionData || {};
    const action  = String(data.action || '').toUpperCase();
    const params  = data.params || {};
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
                (policy.maxPerAction && hasNamedKey(policy.maxPerAction[action])) ||
                !!(policy.maxPerWindow && policy.maxPerWindow.perTick) ||
                (policy.confirmAbove && hasNamedKey(policy.confirmAbove.perTick));
            if (identitySensitive)
                return deny('POLICY_UNRESOLVED_TICK',
                    `${action} references token ${tick} by id, which this policy cannot resolve to a name; ` +
                    `tick-scoped limits cannot bind it (declare it in policy.tickIds, or submit with ` +
                    `compactTickers disabled)`,
                    { action, tick },
                    { action, tick, amount, destinations, needsConfirmation: false });
        }
    }

    const evaluation = { action, tick, amount, destinations, needsConfirmation: false };

    // Fail closed on non-canonical / negative amounts. Every amount gate below is
    // a magnitude comparison (gtDecimal) or a running sum (addDecimal): a negative
    // string sails past the per-action cap, LOWERS the projected window total, and
    // once recorded permanently poisons the velocity window. The amount is decoded
    // verbatim from the WIF holder's PSBT action string (psbtActionDecode.js) with
    // no numeric validation, so it is attacker-controlled and must be validated
    // here before any cap binds it. A canonical non-negative decimal only.
    if (amount !== undefined && !isNonNegativeDecimal(amount))
        return deny('POLICY_AMOUNT_INVALID',
            `${action} amount ${amount} is not a canonical non-negative decimal`,
            { action, tick, amount }, evaluation);

    if (!inCollection(policy.allowedActions, action))
        return deny('POLICY_ACTION_DENIED', `action ${action} is not in allowedActions`, { action }, evaluation);

    if (policy.allowedDestinations) {
        for (const d of destinations)
            if (!inCollection(policy.allowedDestinations, d))
                return deny('POLICY_DESTINATION_DENIED',
                    `destination ${d} is not in allowedDestinations`, { action, destination: d }, evaluation);
    }

    // Fail closed on actions whose outflow the policy cannot measure (see
    // UNBOUNDED_VALUE_ACTIONS) when any amount-based limit is configured. Without
    // this a SWEEP (whole-balance drain, no amount) or an AIRDROP/DIVIDEND (per-unit
    // amount x an off-chain set) would slip past every cap, since those checks are
    // guarded by `amount !== undefined` against a scalar that doesn't represent the
    // real total. A count-only maxActions is not an amount limit and does not trip this.
    if (UNBOUNDED_VALUE_ACTIONS.has(action)) {
        const hasAmountLimit = !!policy.maxPerAction
            || !!(policy.maxPerWindow && policy.maxPerWindow.perTick)
            || !!policy.confirmAbove;
        if (hasAmountLimit)
            return deny('POLICY_UNBOUNDED_ACTION',
                `${action} moves an amount the policy cannot bound from the action alone; ` +
                `it cannot be signed while an amount cap is set (remove the amount cap or disallow ${action})`,
                { action }, evaluation);
    }

    if (policy.maxPerAction && amount !== undefined) {
        const cap = capFor(policy.maxPerAction[action], tick);
        if (cap !== undefined && gtDecimal(amount, cap))
            return deny('POLICY_AMOUNT_EXCEEDED',
                `${action} amount ${amount} exceeds per-action cap ${cap}${tick ? ' for ' + tick : ''}`,
                { action, tick, amount, cap }, evaluation);
    }

    const win = policy.maxPerWindow;
    if (win) {
        const usage = windowUsage || { count: 0, perTick: {} };
        if (win.maxActions !== undefined && usage.count + 1 > win.maxActions)
            return deny('POLICY_WINDOW_COUNT_EXCEEDED',
                `window already holds ${usage.count} actions (max ${win.maxActions} per ${win.hours}h)`,
                { action, count: usage.count, maxActions: win.maxActions }, evaluation);
        if (win.perTick && amount !== undefined && tick !== undefined) {
            const cap = capFor(win.perTick, tick);
            if (cap !== undefined) {
                const projected = addDecimal((usage.perTick && usage.perTick[tick]) || '0', amount);
                if (gtDecimal(projected, cap))
                    return deny('POLICY_WINDOW_AMOUNT_EXCEEDED',
                        `${tick} window total would reach ${projected} (cap ${cap} per ${win.hours}h)`,
                        { action, tick, amount, windowTotal: (usage.perTick && usage.perTick[tick]) || '0', cap }, evaluation);
            }
        }
    }

    if (policy.confirmAbove && amount !== undefined) {
        const threshold = capFor(policy.confirmAbove.perTick, tick);
        if (threshold !== undefined && gtDecimal(amount, threshold)) evaluation.needsConfirmation = true;
    }

    return { ok: true, violation: null, evaluation };
}

module.exports = {
    evaluatePolicy,
    // Exposed so AgentSession and the daemon share the exact same primitives.
    pick,
    capFor,
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
};
