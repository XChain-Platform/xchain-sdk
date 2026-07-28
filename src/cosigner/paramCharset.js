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
 * XChain Platform SDK - Co-Signer Decoded-Param Charset Guard (G3/G1)
 *
 * Decoded action params are attacker-controlled strings: whoever holds the
 * agent WIF writes them into the OP_RETURN the daemon decodes. Several of
 * them are then used as LOOKUP KEYS - `maxPerAction[ACTION][TICK]`, the
 * window store's `perTick[TICK]` accumulator - so a param that collides
 * with an `Object.prototype` member (`constructor`, `toString`, `valueOf`,
 * `__proto__`) resolves to an inherited function instead of the absent
 * value the code expects. A tick of `constructor` is truthy everywhere the
 * code tests for a cap, and feeding a function into decimal addition throws:
 * one in-policy transaction persists the poisoned entry and every later
 * request dies in `snapshot()`, which on a plain 2-of-2 is a permanent,
 * remotely-triggered freeze of the account (G1).
 *
 * Two independent defenses, because neither is sufficient alone:
 *   1. THIS module - validate every decoded param that becomes a lookup key
 *      against the protocol's canonical charset for its field, at decode
 *      time, and fail closed (`DECODE_PARAM_INVALID`) if it does not match.
 *   2. Null-prototype maps + own-property lookups at every site that keys on
 *      one of these values (policyEvaluator, windowStore, vaultWindowStore).
 *
 * Defense 1 alone does NOT close the hole: `constructor`, `toString` and
 * `valueOf` are pure alphanumerics and are therefore perfectly legal TICK
 * names under the protocol charset. A token could genuinely be called
 * CONSTRUCTOR. Defense 2 is what makes those names safe; defense 1 is what
 * keeps the un-enumerable garbage (control characters, delimiter injection,
 * 10kb keys) out of the policy and audit surfaces in the first place.
 *
 ********************************************************************/

'use strict';

// Canonical TICK charset. Byte-for-byte the same rule the SDK validator
// enforces on the authoring side (validator.js `_validateTickName`), which is
// itself pinned to the indexer's TICK_CHARACTERS (consensus). The co-signer
// must never be MORE permissive than consensus: a name consensus would reject
// is a name no real token can have, so accepting it here only widens the set
// of strings that can reach a policy lookup.
const TICK_REGEX = /^[a-zA-Z0-9~!@#$%^&*()_+\-={}[\]:<>.?]+$/;
const MAX_TICK_LENGTH = 250;

// Compact wire-form tick reference (`^<action_index>`), which the SDK emits by
// default for indexed tokens (tickResolver) and which policyEvaluator resolves
// through `policy.tickIds`. It is a legal decoded TICK value even though the
// canonical charset forbids a leading '^', so it is admitted explicitly here
// rather than by widening TICK_REGEX.
const TICK_REF_REGEX = /^\^\d{1,20}$/;

/*
 * Is this a tick value the protocol could actually have produced?
 *
 * @param {*} value
 * @returns {boolean}
 */
function isCanonicalTick(value) {
    if (typeof value !== 'string') return false;
    if (TICK_REF_REGEX.test(value)) return true;
    if (value.length === 0 || value.length > MAX_TICK_LENGTH) return false;
    if (!TICK_REGEX.test(value)) return false;
    // '.' is the parent/child separator (PARENT.CHILD); empty segments are not
    // a name the indexer will ever mint, so a leading/trailing/doubled dot is
    // garbage rather than a sub-token.
    if (value.includes('.') && value.split('.').some((seg) => seg.length === 0)) return false;
    return true;
}

// Fields whose decoded value becomes a lookup key downstream. TICK is the
// direct one; the per-leg tick fields (GIVE_TICK, GET_TICK, DIVIDEND_TICK,
// CALLBACK_TICK) reach the same place through ACTION_VALUE_FIELDS, so the
// suffix rule covers today's formats and any future `*_TICK` without needing
// this list re-edited. Matching by suffix rather than by an enumerated set is
// deliberate: an un-listed new tick field would otherwise silently opt out of
// the guard, which is exactly the drift class G1 came from.
function isTickField(name) {
    return name === 'TICK' || (typeof name === 'string' && name.endsWith('_TICK'));
}

/*
 * Validate every decoded param that can reach a policy or window-store lookup.
 *
 * Absent values ('' / undefined / null) are not validated: the action-string
 * format pads unset trailing fields with empty strings, and `pick()` already
 * treats those as absent, so they never become a key.
 *
 * @param {object} params  the flat decoded param dict
 * @returns {{ok:true} | {ok:false, field:string, value:string}}
 */
function validateDecodedParams(params) {
    if (!params || typeof params !== 'object') return { ok: true };
    for (const field of Object.keys(params)) {
        if (!isTickField(field)) continue;
        const value = params[field];
        if (value === undefined || value === null || value === '') continue;
        if (!isCanonicalTick(value))
            return {
                ok:    false,
                field,
                // Bound the echoed value: it is attacker-controlled and rides into
                // a denial detail that an operator may log.
                value: String(value).slice(0, 64),
            };
    }
    return { ok: true };
}

/*
 * Own-property read of a plain-object table, so an attacker-chosen key can
 * never resolve to an inherited `Object.prototype` member. Every lookup keyed
 * on a decoded param goes through this.
 *
 * @param {object} table
 * @param {string} key
 * @returns {*} the own value, or undefined
 */
function ownLookup(table, key) {
    if (!table || typeof table !== 'object') return undefined;
    if (typeof key !== 'string' && typeof key !== 'number') return undefined;
    return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

module.exports = {
    isCanonicalTick,
    isTickField,
    validateDecodedParams,
    ownLookup,
    TICK_REGEX,
    TICK_REF_REGEX,
    MAX_TICK_LENGTH,
};
