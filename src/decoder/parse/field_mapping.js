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
const { formatVersion } = require('../../protocol/batch_limits/command_classification.js');
const { LEGACY_FORMAT_ACTIONS, isLegacyActionFormat } = require('../../protocol/batch_limits/limit_tables.js');
const { isBytes } = require('../../utils/bytes');

// One shared validator instance for semantic findings (opts.validate).
// Validator only needs the utility helpers; no per-parse state.
const validator = new Validator(new Utility());

function failure(code, detail) {
    return { ok: false, code, detail: detail === undefined ? null : detail };
}

// Decode Buffer input as strict UTF-8; strings pass through.
function toText(input) {
    if (typeof input === 'string') return { text: input };
    if (isBytes(input)) {
        try {
            return { text: new TextDecoder('utf-8', { fatal: true }).decode(input) };
        } catch (e) {
            return { error: failure('BAD_UTF8', e.message) };
        }
    }
    return { error: failure('EMPTY', 'input must be a string or Buffer') };
}

// The strict, fail-closed VERSION reader: only 1-2 plain digits, tokens the indexer
// reads as this same VERSION (its parseInt) and never as a legacy TICK (its length>2
// rule shifts ISSUE/MINT/SEND). The co-signer signs only canonical strings and uses
// this through parse's strictWire mode; the general decoder reads as the indexer does
// (readVersion below).
function parseVersion(segment) {
    if (typeof segment !== 'string' || !/^\d{1,2}$/.test(segment)) return null;
    return Number(segment);
}

/*
 * Read VERSION the way the indexer's dispatcher does (its getFormatVersion, which
 * formatVersion mirrors branch for branch: quotes stripped, any numeric spelling
 * that is not a float and is <= 255 parsed with parseInt, so '00', '+0', '-0' and
 * '0x0' all read 0, an absent or empty token reads 0, anything else is null), after its whitespace trim
 * (xchain-indexer/src/actions/actions_class/transaction.js normalizeTransactionAction):
 * a legacy ISSUE/MINT/SEND with no VERSION token, i.e. one whose first value is
 * longer than two characters or non-numeric, has VERSION 0 injected in front of
 * it, which that file calls permanent consensus behaviour. Returns the version (or
 * null) and the value segments with any injected VERSION in place.
 */
function readVersion(action, valueSegs) {
    const segs = valueSegs.slice();
    let legacy = false;
    if (LEGACY_FORMAT_ACTIONS.includes(action) && isLegacyActionFormat(segs)) {
        segs.unshift('0');
        legacy = true;
    }
    return { version: formatVersion(segs[0]), valueSegs: segs, legacy };
}

// The indexer trims every wire segment before any rule reads it, so a padded value
// is the same value on chain. Compose never emits padding; this is read-side only.
function trimSegments(segments) {
    return segments.map(seg => String(seg).trim());
}

// Version and value segments as the chosen reader sees them (see opts.strictWire).
function readSegments(action, segments, strictWire) {
    if (strictWire)
        return { version: parseVersion(segments[1]), valueSegs: segments.slice(1), legacy: false };
    // VERSION and every value are read as the indexer reads them: trimmed, with
    // the legacy VERSION 0 injected for a versionless ISSUE/MINT/SEND.
    const read = readVersion(action, trimSegments(segments.slice(1)));
    if (read.version === null) return read;
    read.version += 0;   // parseInt('-0') is -0; the format it selects is 0
    // The canonical spelling of the version the indexer read ('+0', '00', an
    // injected legacy 0 all become '0'), so actionString is the canonical action.
    return Object.assign(read, { valueSegs: [String(read.version)].concat(read.valueSegs.slice(1)) });
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
function mapFields(fieldNames, valueSegs, group, strictWire) {
    const params = {};
    let rest = null;

    const restIndex = fieldNames.findIndex(f => FormatSelector.isRestField(f));
    const fixedCount = restIndex === -1 ? fieldNames.length : restIndex;

    // A repeated-field format carries N legs on the wire, not the two its
    // format string spells out, so its length is derived from the segments.
    if (group && restIndex === -1)
        return mapRepeatedFields(group, valueSegs);

    // Segments past a fixed format's last field are ignored on chain: setActionParams
    // walks the format's fields only, so the action reads exactly as if they were
    // absent. They are reported back rather than silently dropped.
    // strictWire (the co-signer) refuses them instead, signing canonical strings only.
    let ignored = null;
    if (restIndex === -1 && valueSegs.length > fieldNames.length && strictWire)
        return { error: failure('FIELD_COUNT_MISMATCH',
            valueSegs.length + ' values vs ' + fieldNames.length + ' fields') };
    if (restIndex === -1 && valueSegs.length > fieldNames.length) {
        ignored = valueSegs.slice(fieldNames.length);
        valueSegs = valueSegs.slice(0, fieldNames.length);
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

    return ignored ? { params, rest, ignored } : { params, rest };
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

/*
 * Validate decoded params. VERSION is handed over with them because several rules
 * are version-dependent (LIST v2/v3, DEPLOY v4, VOTE, DELEGATE) and, without it,
 * judge a string against an auto-selected format the wire did not name.
 *
 * Findings tagged details.sdkGuard are compose-time user-protection guards, not
 * consensus rules (a zero SEND, an empty BROADCAST): the chain accepts what they
 * refuse, so they are returned apart as `guards` and never flip `ok`, which keeps
 * this verdict equal to the indexer's on everything the chain can carry.
 */
function runValidation(action, params, fieldNames, extraFindings, version) {
    let all = [];
    const fields = validatorFields(params, fieldNames);
    if (version !== undefined && version !== null) fields.VERSION = String(version);
    try {
        all = validator.validate(action, fields) || [];
    } catch (e) {
        all = [{ code: 'VALIDATOR_ERROR', message: e.message, details: {} }];
    }
    all = all.concat(extraFindings || []);
    const isGuard = (f) => !!(f && f.details && f.details.sdkGuard === true);
    const findings = all.filter(f => !isGuard(f));
    return { ok: findings.length === 0, findings, guards: all.filter(isGuard) };
}

module.exports = {
    validator,
    failure,
    toText,
    parseVersion,
    readVersion,
    trimSegments,
    readSegments,
    mapFields,
    mapRepeatedFields,
    canonicalize,
    validatorFields,
    runValidation,
};
