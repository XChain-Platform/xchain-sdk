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
 * XChain Platform SDK - PSBT Action Decoder (co-signer)
 *
 * Recovers the XChain action (type + params) from a PSBT, so the MuSig2
 * co-signer can evaluate spending policy against what will ACTUALLY
 * broadcast, not against whatever the client claims. The PSBT is the
 * authority.
 *
 * This mirrors the authoritative on-chain extraction in
 * xchain-decoder/src/XChainDecoder.js (parseTransaction). That decoder is
 * service-bound (DB + node RPC), so it cannot be imported; the pure
 * extraction path is re-implemented here using the SAME primitives
 * (bitcoinjs-lib + the magic word + AES-128-CTR obfuscation keyed by the
 * first input's txid) and verified against a faithful round-trip of the
 * encoder's forward construction.
 *
 * SCOPE (slice 1): the single inline OP_RETURN encoding only. It FAILS
 * CLOSED (returns { ok:false, reason }) on anything it cannot fully and
 * unambiguously decode - P2SH/P2WSH (action params are not in this PSBT;
 * two-phase), MULTISIGN, multi-leg actions whose repeated value fields the
 * single-leg policy evaluator would under-count, rest-fields, unknown
 * actions, and any malformed/encrypted/decompile/utf8 failure. A refusal
 * to sign is always safe; a silent misparse is the only unacceptable
 * outcome.
 *
 * KNOWN GAP (later slice): actions whose value/destination ride real tx
 * OUTPUTS rather than the action string (native-coin legs) are NOT
 * cross-checked here; this decoder reflects only the action-string params.
 * The server/policy layer must not trust output-bearing actions until that
 * cross-check exists.
 *
 ********************************************************************/

'use strict';

const bitcoin        = require('bitcoinjs-lib');
const FormatSelector = require('../protocol/format_selector.js');
const { envelopeLeafFromPsbtInput, parseEnvelopeScript } = require('./envelope.js');
const { ENVELOPE_MAX_PAYLOAD } = require('../protocol/constants.js');
const { MAX_ACTION_DATA_LENGTH } = require('../contract/chunk_helper.js');
const {
    fail, MAGIC_WORD, P2SH_TAG, P2WSH_TAG, OBFUSCATION,
    extractInlineActionString, extractEnvelopeActionString,
} = require('./psbt_action_decode/action_string_extract.js');

// Documented on-chain action aliases, expanded BEFORE format lookup / policy:
// a spec-following client may encode any of these leading tokens and produce a
// valid on-chain payload, so the co-signer must judge the canonical action,
// not refuse the alias. Single in-repo source (decoder/aliases.js),
// manifest-conformance-guarded there.
const { ACTION_ALIASES } = require('../decoder/aliases.js');
const { parse: parseActionString } = require('../decoder/parse.js');

// Decoded params are attacker-controlled and several of them become lookup
// keys in the policy tables and the window store, so they are charset-checked
// here, at the decode boundary, before anything downstream can key on them.
const { validateDecodedParams, ownLookup } = require('./policy/param_charset.js');

// Repeated value-bearing fields mean a multi-output action (e.g. SEND v1/v2/v3).
// The single-leg policy evaluator reads one tick/amount, so a flat dict would
// silently under-count the other legs - a policy bypass. Fail closed instead.
const VALUE_FIELDS = new Set(['TICK', 'AMOUNT', 'DESTINATION']);

/*
 * BOUNDED REST-FIELD FORMATS
 *
 * A rest field ('...NAME') absorbs every remaining segment, so its arity is
 * attacker-chosen. That is refused wholesale for good reason: if a rest field
 * could carry VALUE-bearing entries, the single-leg evaluator would read one
 * scalar and silently under-count the others, which is a policy bypass.
 *
 * The refusal is a blanket one though, and it cost the entire contract-call
 * surface: EXECUTE's only wire format ends in `...PARAMS`, so an agent behind a
 * co-signer could not call a contract AT ALL, whatever its policy said.
 *
 * A format may be admitted here only when its rest field provably cannot carry
 * value the evaluator would need to count. For EXECUTE v0 that holds for a
 * reason stronger than the rest field itself: the value an EXECUTE moves is
 * decided by the CONTRACT'S CODE at the referenced CONTRACT_ACTION_INDEX, never
 * by the action string, and gas is metered by actual VM consumption rather than
 * declared. So the params are opaque method arguments, and the action is
 * classified UNBOUNDED in value_derivability.js - it is refused outright whenever
 * the policy carries ANY amount limit. That is what makes under-counting
 * impossible here: not a cleverer parse, but the fact that no amount cap is ever
 * allowed to bind an action whose amount lives off-string.
 *
 * The parse is bounded regardless, so a crafted payload cannot turn one request
 * into unbounded work (the same class of concern as G14).
 */
const MAX_REST_PARAMS = 32;
const BOUNDED_REST_FORMATS = new Map([
    ['EXECUTE 0', { restField: '...PARAMS', maxParams: MAX_REST_PARAMS }],
]);

function boundedRestFormat(action, version) {
    return BOUNDED_REST_FORMATS.get(`${action} ${version}`) || null;
}

function decodeActionFromPsbt(psbtOrHex, opts = {}) {
    // An envelope reveal carries no OP_RETURN action at all, so route on the
    // shape of the PSBT rather than on a caller-supplied flag. The inline path
    // is unchanged for every other transaction.
    let psbtObj = null;
    if (typeof psbtOrHex !== 'string') psbtObj = psbtOrHex;
    else {
        try { psbtObj = bitcoin.Psbt.fromHex(psbtOrHex, opts.network ? { network: opts.network } : undefined); }
        catch (e) { return fail('PSBT_PARSE_FAILED', e.message); }
    }
    const carriesEnvelope = psbtObj && psbtObj.data && Array.isArray(psbtObj.data.inputs)
        && psbtObj.data.inputs.some((inp) => !!envelopeLeafFromPsbtInput(inp));

    const extracted = carriesEnvelope
        ? extractEnvelopeActionString(psbtObj)
        : extractInlineActionString(psbtOrHex, opts);
    if (!extracted.ok) return extracted;
    return judgeActionString(extracted.actionString);
}

/*
 * Decode the action an envelope LEAF SCRIPT declares, with no transaction in
 * hand. This is the commit-side half of the §3.9 delta (c): at commit time
 * the action is not in the transaction at all, only the hash of the leaf that
 * carries it is, so the daemon reads it from the script whose hash it has
 * already matched against a commit output. Runs the identical judgment as
 * every other route.
 */
function decodeEnvelopeAction(script) {
    const parsed = parseEnvelopeScript(script);
    if (!parsed) return fail('ENVELOPE_SCRIPT_INVALID');
    if (parsed.payload.length > ENVELOPE_MAX_PAYLOAD) return fail('OVERSIZED');
    let decompiled;
    try { decompiled = bitcoin.script.decompile(parsed.payload); }
    catch (e) { return fail('INNER_DECOMPILE_FAILED', e.message); }
    if (!decompiled || decompiled.length === 0 || !Buffer.isBuffer(decompiled[0]))
        return fail('INNER_DECOMPILE_FAILED');
    let actionString;
    try { actionString = new TextDecoder('utf-8', { fatal: true }).decode(decompiled[0]); }
    catch (e) { return fail('NOT_UTF8'); }
    return judgeActionString(actionString);
}

function resolveActionFormat(segments) {
    // Resolve documented aliases to the canonical action, exactly as the
    // authoritative decoder/indexer do before validating/recording. Mirrors
    // XChainDecoder.js:1384-1386: the raw action token is NOT case-folded
    // before the alias/format lookup. ACTION_ALIASES and the formats.js
    // table are both keyed by exact-case canonical names, so a non-canonical-
    // case token (e.g. "send" instead of "SEND") matches neither, falls
    // through to the UNKNOWN_ACTION failure below, and is refused - the same
    // "no action" outcome the arbiter/indexer give it, instead of the
    // co-signer silently upper-casing its way into signing a payload the
    // rest of the protocol treats as unrecognized.
    const rawAction = String(segments[0]);
    // Own-property read: a raw action token of 'constructor' / 'toString' would
    // otherwise resolve to an inherited Object.prototype function and be carried
    // forward as the "action", exposing the same prototype-chain vulnerability.
    const action  = ownLookup(ACTION_ALIASES, rawAction) ?? rawAction;
    const version = Number(segments[1]);
    if (!Number.isInteger(version) || version < 0) return fail('BAD_VERSION');

    let fieldNames;
    try { fieldNames = FormatSelector.getFormatFields(action, version); }
    catch (e) { return fail('UNKNOWN_ACTION', `${action} v${version}`); }
    if (!Array.isArray(fieldNames) || fieldNames[0] !== 'VERSION') return fail('UNEXPECTED_FORMAT');

    return { ok: true, action, version, fieldNames };
}

function validateActionShape(action, version, fieldNames) {
    // Reject variable-length (rest) fields and repeated value fields up front:
    // both are multi-value shapes the single-leg evaluator can't safely judge.
    const bounded = boundedRestFormat(action, version);
    const seen = new Set();
    for (const f of fieldNames) {
        // A rest field is refused unless this exact (action, version) has been
        // analysed and admitted above, AND the rest field is the one that was
        // analysed (a format revision that moved or renamed it must be re-read,
        // not inherited).
        if (FormatSelector.isRestField(f)) {
            if (!bounded || bounded.restField !== f) return fail('REST_FIELD_UNSUPPORTED', f);
            continue;
        }
        if (VALUE_FIELDS.has(f)) {
            if (seen.has(f)) return fail('MULTI_LEG_UNSUPPORTED', f);
            seen.add(f);
        }
    }
    // Belt and braces: refuse ANY repeated per-leg group, not only ones that
    // repeat a VALUE_FIELD. parse() returns array-valued params plus `legs`
    // for those, which the flat single-leg evaluator would mis-read. Every
    // format in the table today repeats TICK or AMOUNT and is already caught
    // above; this keeps a future group shape from slipping through.
    let repeated = null;
    try { repeated = FormatSelector.getRepeatedGroup(action, version); }
    catch (e) { return fail('MULTI_LEG_UNSUPPORTED', e.message); }
    if (repeated) return fail('MULTI_LEG_UNSUPPORTED', repeated.group.join('|'));

    return { ok: true, bounded };
}

function parseActionParams(actionString, action, version, bounded) {
    // BATCH bundles N sub-commands into one action. The evaluator judges a
    // SINGLE leg - one action, one amount, one tick - so it cannot bound a
    // bundle at all, and there is no version of it that it could.
    //
    // A segment-count heuristic is insufficient because a three-segment BATCH
    // can reach the evaluator with no amount, tick or destination. Refuse it
    // structurally: the action disqualifies it, not a particular payload shape.
    if (action === 'BATCH') return fail('BATCH_UNSUPPORTED');

    // Field extraction delegates to the canonical decoder.parse():
    // same segment->field alignment, same trailing-empty padding,
    // same FIELD_COUNT_MISMATCH refusal. The rest/multi-leg punts above make
    // parse()'s array-valued shapes unreachable here, so params stays the
    // flat single-leg dict the policy evaluator expects. The returned
    // actionString stays the RAW decoded string (contract frozen: aliases
    // are NOT rewritten in it), while action is the canonical name.
    const parsed = parseActionString(actionString, { validate: false });
    if (!parsed.ok) {
        if (parsed.code === 'FIELD_COUNT_MISMATCH') return fail('FIELD_COUNT_MISMATCH', parsed.detail);
        return fail('UNKNOWN_ACTION', `${action} v${version}`);
    }

    // Bound the admitted rest field's arity. parse() has already sliced the
    // trailing segments into an array under the base name; cap how many we will
    // carry so one crafted payload cannot expand into unbounded downstream work.
    if (bounded) {
        const base = FormatSelector.baseFieldName(bounded.restField);
        const restValue = ownLookup(parsed.params, base);
        if (Array.isArray(restValue) && restValue.length > bounded.maxParams)
            return fail('REST_FIELD_TOO_LONG', `${base} has ${restValue.length} entries (max ${bounded.maxParams})`);
    }

    // Charset-check every decoded param that becomes a lookup key downstream
    // (TICK and the per-leg *_TICK fields). A tick the protocol could never mint
    // has no legitimate reason to reach a policy table or the persisted window,
    // where it is a poison-pill: one approved action writes the entry, and every
    // later request then dies accumulating it - a permanent remote freeze of a
    // plain 2-of-2 account. Fail closed at the decode boundary instead.
    const paramCheck = validateDecodedParams(parsed.params);
    if (!paramCheck.ok)
        return fail('PARAM_INVALID', `${paramCheck.field}=${paramCheck.value}`);

    return { ok: true, action, version, params: parsed.params, actionString };
}

// The single judgment path shared by the inline, envelope-reveal and
// envelope-commit routes: format lookup, rest/multi-leg refusals, BATCH,
// param extraction and charset validation.
function judgeActionString(actionString) {
    const segments = actionString.split('|');
    if (segments.length < 2) return fail('MALFORMED_ACTION_STRING');

    const format = resolveActionFormat(segments);
    if (!format.ok) return format;

    const shape = validateActionShape(format.action, format.version, format.fieldNames);
    if (!shape.ok) return shape;

    return parseActionParams(actionString, format.action, format.version, shape.bounded);
}

/*
 * Recover ONLY the raw inline OP_RETURN action string from a PSBT, byte-for-
 * byte as the encoder wrote it, applying NO format/field/rest/multi-leg gates.
 *
 * This is the correct primitive for a SELF-SIGN tamper check: the caller
 * already holds the intended action string and only needs to prove the PSBT's
 * OP_RETURN encodes exactly those bytes. Unlike decodeActionFromPsbt - whose
 * fail-closed rest/multi-leg refusals exist to protect the co-signer's single-
 * leg POLICY evaluator (which cannot judge multi-value shapes) - a pure byte
 * comparison is safe and complete for EVERY action, including rest-field
 * actions (EXECUTE '...PARAMS', LIST '...ITEM'). Using decodeActionFromPsbt for
 * the self-sign byte-match wrongly rejected those actions as tampered even
 * though the bytes were correct (xchain-wallet composeActionForConfirm ->
 * confirmChecks.checkActionByteMatch).
 *
 * @param {bitcoin.Psbt|string} psbtOrHex  a bitcoinjs Psbt or its hex
 * @param {object} [opts]   { network } for hex parsing
 * @returns { ok:true, actionString } | { ok:false, reason, detail }
 */
function decodeActionStringFromPsbt(psbtOrHex, opts = {}) {
    return extractInlineActionString(psbtOrHex, opts);
}

// MAX_ACTION_DATA_LENGTH re-exported so parity/drift guards can assert the
// co-signer gate rides the shared (chunkHelper-sourced) cap.
// BOUNDED_REST_FORMATS is exported so valueDerivability.decodableFormats() can
// mirror this decoder's gates exactly. If the two drift, the conformance tests
// there fail rather than a format silently becoming reachable but unclassified.
// MAGIC_WORD / P2SH_TAG / P2WSH_TAG / OBFUSCATION are exported for the
// roundtrip-conformance guard, which pins them against the shared
// encoder->decoder fixture; nothing in the signing path should read them.
module.exports = { decodeActionFromPsbt, decodeActionStringFromPsbt, extractEnvelopeActionString,
                   decodeEnvelopeAction,
                   MAX_ACTION_DATA_LENGTH, ENVELOPE_MAX_PAYLOAD,
                   BOUNDED_REST_FORMATS, MAX_REST_PARAMS,
                   MAGIC_WORD, P2SH_TAG, P2WSH_TAG, OBFUSCATION };
