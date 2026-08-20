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
// xchain-indexer/src/config.js (config['GAS']). Vendored single source of truth:
// ../protocol/constants.js (byte-identical to xchain-documentation/protocol/
// constants.js, GAS_TICK); the cross-service drift guard in xchain-e2e-test
// asserts all three stay equal.
const GAS_TICK = require('../protocol/constants.js').GAS_TICK;

// Format field lists, for the DESTINATION-carrying check (G9).
const FormatSelector = require('../formatSelector.js');

// Own-property lookup for every table keyed on a decoded param, and the
// (action, version) value-derivability table an amount cap can actually bind.
const { ownLookup } = require('./paramCharset.js');
const valueDerivability = require('./valueDerivability.js');

// Per-action value/tick fields for actions whose primary outflow is NOT the
// generic amount/AMOUNT + tick/TICK pair. The cap must bind to what the signer
// GIVES AWAY, so the two-leg trade actions use the GIVE leg. Without this the
// amount pick returns undefined and every amount cap is silently skipped, leaving
// DEPOSIT / WITHDRAW / ORDER / SWAP / DISPENSER / VOTE uncapped. (SEND / DESTROY /
// STAKE / MINT etc. carry AMOUNT and need no entry.)
const ACTION_VALUE_FIELDS = {
    DEPOSIT:   { amount: ['quantity', 'QUANTITY'],      tick: TICK_KEYS },
    WITHDRAW:  { amount: ['quantity', 'QUANTITY'],      tick: TICK_KEYS },
    ORDER:     { amount: ['giveAmount', 'GIVE_AMOUNT'], tick: ['giveTick', 'GIVE_TICK'] },
    SWAP:      { amount: ['giveAmount', 'GIVE_AMOUNT'], tick: ['giveTick', 'GIVE_TICK'] },
    // The signer's fund exposure at creation is GIVE_ESCROW (the balance debited into the
    // dispenser, indexer dispenser.js), NOT GIVE_AMOUNT (the per-trigger dispense quantity paid
    // out of that escrow later). Binding the cap to GIVE_AMOUNT left every DISPENSER escrow
    // uncapped; ownership dispensers carry no GIVE_ESCROW, so their cap correctly no-ops.
    DISPENSER: { amount: ['giveEscrow', 'GIVE_ESCROW'], tick: ['giveTick', 'GIVE_TICK'] },
    // Capability STAKE (v1/v2) stakes the gas token with no TICK field; default the
    // tick so gas-scoped caps bind. Contract-targeted STAKE v3 carries TICK, which
    // pick() prefers over the default.
    STAKE:     { amount: AMOUNT_KEYS, tick: TICK_KEYS, tickDefault: GAS_TICK },
    // VOTE v0 carries no AMOUNT field but DOES move funds: it escrows DEPOSIT + GAS_ESCROW
    // TOGETHER, both denominated in the gas tick (VOTE.md). With no entry the generic pick
    // returned undefined and every VOTE amount cap (per-action, per-window, confirmAbove) was
    // silently skipped. Sum both escrowed legs.
    //
    // tickFixed, NOT tickDefault: VOTE v0's own TICK field names the GOVERNANCE token (the
    // electorate and weight basis), which is a different token from the gas the deposit and
    // callback escrow are actually denominated in. Preferring the decoded TICK - as a
    // tickDefault does - bound the cap to the wrong denomination entirely: a
    // maxPerWindow.perTick.XCHAIN ceiling never bound the gas the vote really spends, while
    // the governance token's budget was consumed by spending that never touched it. The
    // escrow is gas, always, so the tick is fixed and the decoded TICK is ignored here.
    VOTE:      { amountSum: [['deposit', 'DEPOSIT'], ['gasEscrow', 'GAS_ESCROW']], tickFixed: GAS_TICK },
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
    for (const k of keys) {
        const v = ownLookup(params, k);
        if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
}

// Resolve the (amount, tick) the caps should bind to for this action.
function resolveValue(action, params) {
    const spec = ownLookup(ACTION_VALUE_FIELDS, action);
    if (spec) {
        const tick = spec.tickFixed !== undefined ? spec.tickFixed : pick(params, spec.tick);
        let amount;
        if (spec.amountSum) {
            // Several escrowed legs bound as one total (e.g. VOTE escrows DEPOSIT + GAS_ESCROW
            // together). A missing leg counts as 0, but amount stays undefined only when EVERY
            // leg is absent, so a single present leg still binds the cap.
            // Each leg is validated BEFORE it is summed, and a bad one is carried out
            // raw as the resolved amount so evaluatePolicy's POLICY_AMOUNT_INVALID gate
            // refuses it, exactly as the single-amount path does. Two reasons, both
            // reachable from the WIF holder's verbatim action string: addDecimal is
            // math.bignumber(), which THROWS on a non-numeric leg ('abc'), and that throw
            // fires inside resolveValue, ahead of the gate, so the daemon's policy path
            // raised instead of denying; and a NEGATIVE leg sums fine, shrinking the total
            // the caps bind to, which is the cap bypass the gate's own comment describes.
            let any = false, total = '0', invalid;
            for (const keys of spec.amountSum) {
                const v = pick(params, keys);
                if (v === undefined) continue;
                any = true;
                if (invalid !== undefined) continue;
                if (isNonNegativeDecimal(v)) total = addDecimal(total, v);
                else invalid = v;
            }
            amount = invalid !== undefined ? invalid : (any ? total : undefined);
        } else {
            amount = pick(params, spec.amount);
        }
        return {
            amount,
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

// Cap lookup keyed on a DECODED (attacker-chosen) tick. Both reads go through
// ownLookup: a plain `table[tick]` with tick = 'constructor' / 'toString' /
// 'valueOf' returns an inherited Object.prototype member, which is truthy and
// !== undefined, so the wrong branch is taken and a function is then fed into
// decimal comparison (G1). Own-property reads make every inherited name resolve
// to "no cap configured", which is the truth.
function capFor(table, tick) {
    if (!table) return undefined;
    if (tick !== undefined) {
        const own = ownLookup(table, tick);
        if (own !== undefined) return own;
    }
    return ownLookup(table, '*');
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

// Does this (action, version) format carry a DESTINATION field at all? (G9)
// Read from the format table rather than from the decoded params, so an action
// that merely LEFT its optional destination empty is still recognized as
// constrainable, while one whose format has no such field is not.
function formatCarriesDestination(action, version) {
    let fields;
    try { fields = FormatSelector.getFormatFields(action, version); } catch (e) { return false; }
    return Array.isArray(fields) && fields.some((f) => f === 'DESTINATION' || f === 'DESTINATIONS');
}

// Reserved window bucket for entries whose tick the evaluator could not resolve
// (G8). '|' is the action-string FIELD SEPARATOR, so it can never appear in a
// real tick: a tick containing one would corrupt the wire format itself. That
// keeps the bucket outside the protocol's tick charset by construction, so no
// token can ever collide with it.
const UNRESOLVED_TICK_BUCKET = '|unresolved|';

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
 * @param {object} actionData  { action, version?, params } (params may use camelCase or UPPER_SNAKE).
 *   `version` is optional: when present (the co-signer daemon decodes it from the PSBT) the
 *   value-derivability table is enforced, so an action whose outflow the evaluator cannot read
 *   is denied instead of silently skipping every amount gate. See valueDerivability.js.
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
        // G9: allowedDestinations binds only the action-string DESTINATION field,
        // and only 6 of the 63 decodable formats carry one (SEND v0, MINT v0,
        // MESSAGE v0-v3, SWEEP v0). For every other format the destination list is
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

    if (policy.maxPerAction && amount !== undefined) {
        const cap = capFor(ownLookup(policy.maxPerAction, action), tick);
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
        // No `tick !== undefined` guard here: capFor falls through to the '*'
        // entry exactly like the maxPerAction and confirmAbove gates, so an
        // amount-bearing action whose tick did not resolve is still bound by a
        // wildcard window cap (the old extra guard let such an action
        // bypass the one amount ceiling a wildcard-only policy expresses).
        //
        // G8: an unresolved tick reads its running total from a RESERVED BUCKET
        // that the stores accumulate such entries under. Previously the used
        // total for those was hard-coded to '0' - the stores skipped undefined-
        // tick entries entirely - so the projected total was always
        // `0 + amount` and a wildcard window cap bound each transaction
        // INDEPENDENTLY, forever. That is a per-transaction cap wearing a
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
    valueDerivability,
    formatCarriesDestination,
    // Both window stores MUST accumulate unresolved-tick entries under this exact
    // key, or a wildcard window cap silently degrades to a per-transaction cap (G8).
    UNRESOLVED_TICK_BUCKET,
};
