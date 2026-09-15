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
 ********************************************************************/

'use strict';

const { create, all } = require('mathjs');

const { ownLookup } = require('../param_charset.js');

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
// ../protocol/constants.js, whose GAS_TICK is in VALUE PARITY with (not a
// byte-identical copy of) xchain-documentation/protocol/constants.js, which is a
// superset file (uuid:0eb83c45); the cross-service drift guard in xchain-e2e-test
// asserts all three stay equal.
const GAS_TICK = require('../../protocol/constants.js').GAS_TICK;

// Format field lists, for the DESTINATION-carrying check (G9).
const FormatSelector = require('../../protocol/format_selector.js');

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
    // XBRIDGE v0/v1 bridge the GAS token and carry no TICK field at all (a v3 of the
    // gas tick is refused, 'invalid: TICK (use XBRIDGE v0)'), so without a default
    // their tick resolved to undefined and a tick-scoped cap - maxPerAction.XBRIDGE
    // .XCHAIN, maxPerWindow.perTick.XCHAIN - never bound a single lock or burn; only
    // the '*' wildcard applied. Exactly the STAKE v1/v2 shape above, and the reason
    // valueDerivability classifies those two versions DERIVABLE rather than leaving
    // the denomination unreadable.
    //
    // tickDefault, NOT tickFixed: the token-bridge versions v3 and v4 carry their own
    // TICK and debit THAT token (xchain-token-bridge.md section 5), so the decoded
    // value must win. pick() prefers it and falls back here only for v0/v1.
    XBRIDGE:   { amount: AMOUNT_KEYS, tick: TICK_KEYS, tickDefault: GAS_TICK },
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

// Decide whether a cap table can ever BIND. `{}`, `{ SEND: {} }` and
// `{ SEND: { TOK: '' } }` are all truthy, so a ceiling gate written as
// `!!policy.maxPerAction` accepts them while capFor resolves undefined for every
// lookup and the amount gates are skipped: a ceiling the operator believes in and
// the evaluator never applies. Own-property reads throughout, for the same reason
// capFor uses them (G1), so an inherited 'constructor' cannot make an empty table
// look populated. Shapes: one-level { TICK|'*': cap }, two-level
// { ACTION: { TICK|'*': cap } }.
function hasEnforceableCap(table, opts = {}) {
    if (!table || typeof table !== 'object' || Array.isArray(table)) return false;
    for (const key of Object.keys(table)) {
        const value = ownLookup(table, key);
        if (opts.twoLevel) {
            if (hasEnforceableCap(value)) return true;
            continue;
        }
        if (typeof value === 'number' && Number.isFinite(value)) return true;
        if (typeof value === 'string' && value.trim() !== '') return true;
    }
    return false;
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

module.exports = {
    pick,
    resolveValue,
    inCollection,
    capFor,
    hasEnforceableCap,
    resolveTickRef,
    hasNamedKey,
    formatCarriesDestination,
    gtDecimal,
    isNonNegativeDecimal,
    addDecimal,
    AMOUNT_KEYS,
    TICK_KEYS,
    DESTINATION_KEYS,
    GAS_TICK,
    ACTION_VALUE_FIELDS,
    UNBOUNDED_VALUE_ACTIONS,
    UNRESOLVED_TICK_BUCKET,
};
