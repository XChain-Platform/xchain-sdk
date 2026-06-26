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

function pick(params, keys) {
    for (const k of keys)
        if (params && params[k] !== undefined && params[k] !== null && params[k] !== '')
            return params[k];
    return undefined;
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

// Exact decimal comparison via BigNumber methods. mathjs larger()/equal()
// apply an epsilon tolerance, which is exactly wrong for policy caps.
function gtDecimal(a, b) { return math.bignumber(String(a)).gt(math.bignumber(String(b))); }
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
    const tick    = pick(params, TICK_KEYS);
    const amount  = pick(params, AMOUNT_KEYS);
    const destRaw = pick(params, DESTINATION_KEYS);
    const destinations = destRaw === undefined ? []
        : Array.isArray(destRaw) ? destRaw : String(destRaw).split(';');

    const evaluation = { action, tick, amount, destinations, needsConfirmation: false };

    if (!inCollection(policy.allowedActions, action))
        return deny('POLICY_ACTION_DENIED', `action ${action} is not in allowedActions`, { action }, evaluation);

    if (policy.allowedDestinations) {
        for (const d of destinations)
            if (!inCollection(policy.allowedDestinations, d))
                return deny('POLICY_DESTINATION_DENIED',
                    `destination ${d} is not in allowedDestinations`, { action, destination: d }, evaluation);
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
};
