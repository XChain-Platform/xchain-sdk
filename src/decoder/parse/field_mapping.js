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
 * XChain Platform SDK - decoder.parse
 *
 * Canonical action-string parser: "ACTION|VERSION|F1|F2|..." in,
 * structured ParsedAction out. Pure (no network, no vault), hardened
 * for untrusted input: any dApp may feed this arbitrary strings, so
 * the size gate runs BEFORE any split/alias/UTF-8 work and malformed
 * input is a typed { ok:false } return, never a throw.
 *
 * Mirrors the on-chain extraction semantics (xchain-decoder
 * parseTransaction / cosigner psbtActionDecode): case-sensitive action
 * names, alias expansion before format lookup, trailing-empty-field
 * fill exactly as FormatSelector.serialize trims.
 *
 ********************************************************************/

'use strict';

const FormatSelector = require('../../protocol/format_selector.js');
const Validator      = require('../../protocol/validator.js');
const Utility        = require('../../utils/utility.js');

// One shared validator instance for semantic findings (opts.validate).
// Validator only needs the utility helpers; no per-parse state.
const validator = new Validator(new Utility());

function failure(code, detail) {
    return { ok: false, code, detail: detail === undefined ? null : detail };
}

// Decode Buffer input as strict UTF-8; strings pass through.
function toText(input) {
    if (typeof input === 'string') return { text: input };
    if (Buffer.isBuffer(input)) {
        try {
            return { text: new TextDecoder('utf-8', { fatal: true }).decode(input) };
        } catch (e) {
            return { error: failure('BAD_UTF8', e.message) };
        }
    }
    return { error: failure('EMPTY', 'input must be a string or Buffer') };
}

// VERSION segment must be a non-negative integer token, matching the
// on-chain decoder's Number()+isInteger gate (psbtActionDecode BAD_VERSION).
function parseVersion(segment) {
    if (segment === undefined || segment === '') return null;
    const v = Number(segment);
    if (!Number.isInteger(v) || v < 0) return null;
    return v;
}

/*
 * Map value segments onto a format's field list.
 *
 * - fieldNames[0] is always 'VERSION' and aligns with valueSegs[0].
 * - The serializer trims trailing empty fields, so fewer segments than
 *   fields is normal: pad the tail with ''.
 * - A field name repeated in the format (multi-leg SEND v1/v2/v3,
 *   AIRDROP v1-v3, DESTROY v1/v2) collects its slot values into an
 *   array in slot order.
 * - A rest-field ('...NAME', always terminal in formats.js) absorbs
 *   every remaining segment as an array (possibly empty: compose emits
 *   zero segments for an empty rest-field).
 *
 * Returns { params, rest } or { error }.
 */
function mapFields(fieldNames, valueSegs, group) {
    const params = {};
    let rest = null;

    const restIndex = fieldNames.findIndex(f => FormatSelector.isRestField(f));
    const fixedCount = restIndex === -1 ? fieldNames.length : restIndex;

    // A repeated-field format carries N legs on the wire, not the two its
    // format string spells out, so its length is derived from the segments.
    if (group && restIndex === -1)
        return mapRepeatedFields(group, valueSegs);

    if (restIndex === -1 && valueSegs.length > fieldNames.length) {
        return { error: failure('FIELD_COUNT_MISMATCH',
            valueSegs.length + ' values vs ' + fieldNames.length + ' fields') };
    }
    if (restIndex !== -1 && restIndex !== fieldNames.length - 1) {
        // No such format exists today; fail closed if one ever does.
        return { error: failure('MALFORMED_REST', fieldNames[restIndex]) };
    }

    const repeated = new Set();
    const seen = new Set();
    for (let i = 0; i < fixedCount; i++) {
        const name = fieldNames[i];
        if (name === 'VERSION') continue;
        if (seen.has(name)) repeated.add(name); else seen.add(name);
    }

    for (let i = 0; i < fixedCount; i++) {
        const name = fieldNames[i];
        if (name === 'VERSION') continue;
        const value = i < valueSegs.length ? valueSegs[i] : '';
        if (repeated.has(name)) {
            if (!Array.isArray(params[name])) params[name] = [];
            params[name].push(value);
        } else {
            params[name] = value;
        }
    }

    if (restIndex !== -1) {
        const baseName = FormatSelector.baseFieldName(fieldNames[restIndex]);
        rest = valueSegs.slice(fixedCount);
        params[baseName] = rest;
    }

    return { params, rest };
}

/*
 * Map value segments of a repeated-field format (multi-leg SEND v1/v2/v3,
 * DESTROY v1/v2, AIRDROP v1-v3) onto prefix | group * N | suffix.
 *
 * The leg count is whatever the segments imply: the smallest N whose full
 * layout is long enough to hold them. That is exact rather than heuristic
 * because the serializer only ever trims TRAILING empty segments, so a string
 * with more segments than N legs would fill must belong to N+1 legs.
 *
 * Emits both shapes: params[GROUP_FIELD] as a slot-ordered array (the
 * pre-existing contract) and `legs` as one object per leg, which is what
 * FormatSelector.serialize takes back in.
 */
function mapRepeatedFields(group, valueSegs) {
    const per = group.group.length;
    const base = group.prefix.length + group.suffix.length;
    let legCount = 1;
    while (base + (legCount * per) < valueSegs.length) legCount++;

    const total = base + (legCount * per);
    const segs = valueSegs.slice();
    while (segs.length < total) segs.push('');   // undo the serializer's trailing trim

    const params = {};
    let at = 0;
    for (const name of group.prefix) {
        if (name !== 'VERSION') params[name] = segs[at];
        at++;
    }
    const legs = [];
    for (let i = 0; i < legCount; i++) {
        const leg = {};
        for (const name of group.group) {
            leg[name] = segs[at++];
            if (!Array.isArray(params[name])) params[name] = [];
            params[name].push(leg[name]);
        }
        legs.push(leg);
    }
    for (const name of group.suffix)
        params[name] = segs[at++];

    return { params, rest: null, legs };
}

// Canonical round-trippable string: canonical action name + the value
// segments with the trailing-empty trim FormatSelector.serialize
// applies (floor: ACTION|VERSION).
function canonicalize(action, valueSegs) {
    const parts = valueSegs.slice();
    while (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
    return [action, ...parts].join('|');
}

// Project multi-leg arrays to their first slot for validator input:
// validator.js rules are single-leg shaped (TICK/AMOUNT scalars), and
// findings are advisory - first-leg projection keeps them meaningful
// without false-flagging legitimate multi-leg strings. Rest-field
// arrays (ITEM/PARAMS/CONSTRUCTOR_PARAMS) pass through: the validator
// handles those natively.
function validatorFields(params, fieldNames) {
    const restBases = new Set(fieldNames.filter(f => FormatSelector.isRestField(f))
        .map(f => FormatSelector.baseFieldName(f)));
    const projected = {};
    for (const key of Object.keys(params)) {
        const value = params[key];
        projected[key] = (Array.isArray(value) && !restBases.has(key) && value.length > 0)
            ? value[0]
            : value;
    }
    return projected;
}

function runValidation(action, params, fieldNames, extraFindings) {
    let findings = [];
    try {
        findings = validator.validate(action, validatorFields(params, fieldNames)) || [];
    } catch (e) {
        findings = [{ code: 'VALIDATOR_ERROR', message: e.message, details: {} }];
    }
    findings = findings.concat(extraFindings || []);
    return { ok: findings.length === 0, findings };
}

module.exports = {
    validator,
    failure,
    toText,
    parseVersion,
    mapFields,
    mapRepeatedFields,
    canonicalize,
    validatorFields,
    runValidation,
};
