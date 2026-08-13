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

const formats        = require('../formats.js');
const FormatSelector = require('../formatSelector.js');
const Validator      = require('../validator.js');
const Utility        = require('../utility.js');
const { ACTION_ALIASES } = require('./aliases.js');
const { MAX_ACTION_DATA_LENGTH } = require('../chunkHelper.js');

// BATCH limit scan, vendored from the consensus arbiter
// (xchain-indexer/src/actions/batch.js) through the one shared client copy in
// src/batchLimits.js; the conformance unit test guards drift by CLASSIFICATION
// and COUNT, not just by the table's values. BATCH:0 = nested BATCH
// categorically forbidden (a parse failure, not a limit finding).
//
// WHAT `BATCH_ACTION_LIMITS` NAMES HERE, AND WHY IT MOVED
//
// batchLimits.js keeps the arbiter's two tables apart, because the arbiter does:
// the ungated `BATCH_ACTION_LIMITS` and the flag-gated `BATCH_GATED_ACTION_LIMITS`
// (DEPLOY, D5), merged into `BATCH_ACTION_LIMITS_ACTIVE`. This module has only
// ever exported ONE table under the name `BATCH_ACTION_LIMITS`, and
// `decoder/index.js` re-exports exactly that name as the public decoder API.
// So the name is re-pointed at the ACTIVE table rather than left on the ungated
// one: a caller reading `decoder.BATCH_ACTION_LIMITS` to decide what fits in a
// batch must see the same caps `parse` reports findings against, and under the
// old binding it would have read "DEPLOY: uncapped" while parse flagged a second
// DEPLOY. One table, and it is the one this module enforces. The split halves
// are re-exported beside it under their own names for a caller that needs to
// know WHICH caps are flag-dependent; the pre-flag table stays reachable at its
// source in batchLimits.js, deliberately NOT re-exported here, because two
// spellings of "the limits" in one module is how a consumer picks the wrong one.
const {
    BATCH_ACTION_LIMITS_ACTIVE,
    BATCH_GATED_ACTION_LIMITS,
    BATCH_COMMAND_LIMIT,
    classifyCommand,
    commandTick,
    maxMintsPerDistinctTick,
} = require('../batchLimits.js');

const BATCH_ACTION_LIMITS = BATCH_ACTION_LIMITS_ACTIVE;

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

/*
 * decoder.parse - see file header.
 *
 * @param {string|Buffer} input  canonical action text "ACTION|VERSION|F1|..."
 * @param {object} [opts]
 * @param {boolean} [opts.validate=true]  attach validator.js semantic
 *                  findings; they never flip ok=false
 * @returns {object} ParsedAction { ok:true, action, rawAction, version,
 *                   params, rest, commands, actionString, validation }
 *                   or ParseFailure { ok:false, code, detail }
 */
function parse(input, opts = {}) {
    const doValidate = opts.validate !== false;

    if (input === undefined || input === null || input === '' ||
        (Buffer.isBuffer(input) && input.length === 0))
        return failure('EMPTY');

    // Rule 1: input-size gate FIRST, on the raw input, before any
    // split, alias lookup, regex, or UTF-8 work.
    const rawLength = Buffer.isBuffer(input)
        ? input.length
        : Buffer.byteLength(String(input), 'utf8');
    if (rawLength > MAX_ACTION_DATA_LENGTH)
        return failure('TOO_LONG', rawLength + ' bytes > ' + MAX_ACTION_DATA_LENGTH);

    const decoded = toText(input);
    if (decoded.error) return decoded.error;
    const text = decoded.text;
    if (text === '') return failure('EMPTY');

    return parseTopLevel(text, doValidate, false);
}

function parseTopLevel(text, doValidate, insideBatch) {
    const segments = text.split('|');

    // Rule 3: case-sensitive action names, alias table included -
    // "send" matches neither and is UNKNOWN_ACTION, mirroring the
    // on-chain decoder's no-case-fold lookup.
    const rawAction = String(segments[0]);
    const action = ACTION_ALIASES[rawAction] !== undefined ? ACTION_ALIASES[rawAction] : rawAction;
    if (!Object.prototype.hasOwnProperty.call(formats, action))
        return failure('UNKNOWN_ACTION', rawAction);

    const version = parseVersion(segments[1]);
    if (version === null || !formats[action][version])
        return failure('UNKNOWN_VERSION', action + ' v' + String(segments[1]));

    // Rule 8: BATCH sub-grammar. COMMAND is a SINGULAR terminal
    // delimiter-exempt catch-all: the entire remaining tail, verbatim.
    // The generic fixed-field mapping below would mis-slice it on '|',
    // so BATCH branches before field mapping.
    if (action === 'BATCH') {
        if (insideBatch) return failure('NESTED_BATCH_FORBIDDEN');
        return parseBatch(rawAction, version, segments, doValidate);
    }

    const fieldNames = FormatSelector.getFormatFields(action, version);
    let group = null;
    try { group = FormatSelector.getRepeatedGroup(action, version); }
    catch (e) { return failure('UNSUPPORTED_REPEATED_FORMAT', e.message); }
    const valueSegs = segments.slice(1);
    const mapped = mapFields(fieldNames, valueSegs, group);
    if (mapped.error) return mapped.error;

    const result = {
        ok: true,
        action,
        rawAction: rawAction === action ? undefined : rawAction,
        version,
        params: mapped.params,
        rest: mapped.rest,
        commands: null,
        actionString: canonicalize(action, valueSegs),
        validation: null,
    };
    if (result.rawAction === undefined) delete result.rawAction;
    // Multi-leg formats additionally expose the legs in the shape
    // FormatSelector.serialize accepts, so parse -> edit -> re-serialize
    // round-trips without the caller re-deriving the group layout.
    if (mapped.legs) result.legs = mapped.legs;

    if (doValidate)
        result.validation = runValidation(action, mapped.params, fieldNames, []);

    return result;
}

function parseBatch(rawAction, version, segments, doValidate) {
    // 3-way top-level split: ACTION, VERSION, verbatim tail.
    const tail = segments.slice(2).join('|');

    // COMMAND absent entirely (BATCH|0) => validator finding, ok stays
    // true; present-but-empty (BATCH|0|) => parse failure.
    if (segments.length <= 2) {
        const result = {
            ok: true,
            action: 'BATCH',
            version,
            params: { COMMAND: '' },
            rest: null,
            commands: [],
            actionString: canonicalize('BATCH', segments.slice(1)),
            validation: null,
        };
        if (doValidate)
            result.validation = runValidation('BATCH', { COMMAND: '' }, ['VERSION', 'COMMAND'], []);
        return result;
    }
    if (tail === '') return failure('EMPTY_BATCH');

    const entries = tail.split(';');
    const commands = [];
    const counts = {};
    // MINT TICKs, collected in the SAME pass that counts them so the two can
    // never disagree about which entries are MINTs (D7 caps MINT per DISTINCT
    // token, so the count alone no longer answers the question).
    const mintTicks = [];
    for (const entry of entries) {
        const sub = entry === ''
            ? failure('EMPTY', 'empty BATCH command')
            : parseTopLevel(entry, doValidate, true);
        // A sub-entry that IS a BATCH flips the OUTER result: nested
        // BATCH is categorically forbidden (indexer actionLimits
        // BATCH:0), not a per-command recoverable failure.
        if (sub.ok === false && sub.code === 'NESTED_BATCH_FORBIDDEN')
            return failure('NESTED_BATCH_FORBIDDEN');
        // Counted off the RAW entry, whether or not it parsed. The arbiter
        // counts every command in the ';'-split list; counting only the entries
        // this parser accepted made an unparseable ISSUE - or an empty element -
        // free here and chargeable on-chain. classifyCommand also buckets a
        // dotted-TICK ISSUE as a child, which is exempt from the top-level cap.
        const key = classifyCommand(entry);
        counts[key] = (counts[key] || 0) + 1;
        if (key === 'MINT') mintTicks.push(commandTick(entry));
        commands.push(sub);
    }

    // Caps -> validation findings, not parse failures.
    const extraFindings = [];
    // The global command cap runs FIRST and alone: on-chain it rejects the whole
    // batch before any per-action count is taken, so emitting a per-action
    // finding alongside it would describe a rule the chain never reached.
    // Empty elements count (a trailing ';' is a command).
    if (entries.length > BATCH_COMMAND_LIMIT) {
        extraFindings.push({
            code: 'BATCH_LIMIT_EXCEEDED',
            message: 'BATCH allows at most ' + BATCH_COMMAND_LIMIT + ' commands; got ' + entries.length,
            details: { action: 'COMMAND', limit: BATCH_COMMAND_LIMIT, count: entries.length },
        });
    } else {
        // D7: MINT's cap is per DISTINCT token, so what the cap is compared
        // against is the largest number of MINTs naming ONE token, not the raw
        // occurrence count. Minting twelve different tokens in one transaction
        // takes nothing from anyone; twelve MINTs of one contended token do.
        const mint = mintTicks.length
            ? maxMintsPerDistinctTick(mintTicks)
            : { max: 0, approximate: false };
        for (const a of Object.keys(counts)) {
            const limit = BATCH_ACTION_LIMITS[a];
            if (limit === undefined) continue;
            // `mint.approximate` is NOT a reason to stay silent, and the
            // asymmetry is why. Keying on literal strings can only SPLIT what
            // the arbiter merges - a caret and a name may be one token, never
            // two - so this maximum is a LOWER BOUND on the arbiter's, and a
            // lower bound over the cap is a CERTAIN breach worth reporting.
            // Only the ABSENCE of a finding is ever in doubt, which is what the
            // flag tells a caller that asks. Standing down on the flag instead
            // let one unrelated caret silence a breach a literal MINT repeat
            // had already proved. See batchLimits.js's header.
            const observed = a === 'MINT' ? mint.max : counts[a];
            if (observed > limit) {
                // MINT's message names the DISTINCT-token unit, because `count`
                // is the largest run naming one token and a reader who took it
                // for the number of MINTs in the batch would go looking for
                // sub-commands that are not there.
                const plural = limit === 1 ? '' : 's';
                const subject = a === 'ISSUE' ? 'top-level ISSUE command' + plural
                    : a === 'MINT' ? 'MINT per DISTINCT token'
                    : a + ' command' + plural;
                extraFindings.push({
                    code: 'BATCH_LIMIT_EXCEEDED',
                    message: 'BATCH allows at most ' + limit + ' ' + subject + '; got ' + observed,
                    details: { action: a, limit, count: observed },
                });
            }
        }
    }

    const result = {
        ok: true,
        action: 'BATCH',
        version,
        params: { COMMAND: tail },
        rest: null,
        commands,
        actionString: canonicalize('BATCH', segments.slice(1)),
        validation: null,
    };
    if (doValidate)
        result.validation = runValidation('BATCH', { COMMAND: tail }, ['VERSION', 'COMMAND'], extraFindings);
    return result;
}

module.exports = {
    parse,
    BATCH_ACTION_LIMITS,
    // Same object as above, under the spelling the compose-side sites import it
    // by, so a sweep for the active table finds this module too.
    BATCH_ACTION_LIMITS_ACTIVE,
    // The flag-dependent half on its own, for a caller that must tell an
    // always-on cap from one that only binds at/after BATCH_ISSUANCE_LIMITS.
    BATCH_GATED_ACTION_LIMITS,
    BATCH_COMMAND_LIMIT,
};
