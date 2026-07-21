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

const crypto         = require('crypto');
const bitcoin        = require('bitcoinjs-lib');
const FormatSelector = require('../formatSelector.js');

// Mirror xchain-decoder/src/XChainDecoder.js:44-63. The action-data cap is
// imported from chunkHelper.js (the SDK's single parity-guarded copy) so the
// co-signer's OVERSIZED gate cannot drift from the rest of the SDK.
const MAGIC_WORD = Buffer.from('XCHN');
const P2SH_TAG   = Buffer.from('p2sh');
const P2WSH_TAG  = Buffer.from('p2wsh');
const { MAX_ACTION_DATA_LENGTH } = require('../chunkHelper.js');

// Documented on-chain action aliases, expanded BEFORE format lookup / policy:
// a spec-following client may encode any of these leading tokens and produce a
// valid on-chain payload, so the co-signer must judge the canonical action,
// not refuse the alias. Single in-repo source (decoder/aliases.js),
// manifest-conformance-guarded there.
const { ACTION_ALIASES } = require('../decoder/aliases.js');
const { parse: parseActionString } = require('../decoder/parse.js');

// Repeated value-bearing fields mean a multi-output action (e.g. SEND v1/v2/v3).
// The single-leg policy evaluator reads one tick/amount, so a flat dict would
// silently under-count the other legs - a policy bypass. Fail closed instead.
const VALUE_FIELDS = new Set(['TICK', 'AMOUNT', 'DESTINATION']);

function fail(reason, detail) { return { ok: false, reason, detail: detail || null }; }

// AES-128-CTR de-obfuscation, key/iv = first 16 / next 16 hex chars of the
// first input's txid. Verbatim from XChainDecoder.removeObfuscation (and the
// inverse of XChainEncoder.obfuscate).
function deobfuscate(data, txidHex) {
    const key = txidHex.substr(0, 16);
    const iv  = txidHex.substr(16, 16);
    const d   = crypto.createDecipheriv('aes-128-ctr', key, iv);
    return Buffer.concat([d.update(data), d.final()]);
}

/*
 * Decode an XChain action from a PSBT.
 *
 * @param {bitcoin.Psbt|string} psbtOrHex  a bitcoinjs Psbt or its hex
 * @param {object} [opts]   { network } for hex parsing
 * @returns {object}
 *   { ok:true,  action, version, params:{FIELD:value}, actionString }
 *   { ok:false, reason, detail }   (fail closed - the co-signer must refuse)
 */
function decodeActionFromPsbt(psbtOrHex, opts = {}) {
    let psbt;
    try {
        psbt = (typeof psbtOrHex === 'string')
            ? bitcoin.Psbt.fromHex(psbtOrHex, opts.network ? { network: opts.network } : undefined)
            : psbtOrHex;
    } catch (e) { return fail('PSBT_PARSE_FAILED', e.message); }

    if (!psbt || !psbt.txInputs || psbt.txInputs.length === 0) return fail('NO_INPUTS');

    // Obfuscation key = first input's txid (display order = reverse of the
    // internal hash). Mirrors XChainDecoder.js:384.
    const firstInputTxid = Buffer.from(psbt.txInputs[0].hash).reverse().toString('hex');

    // Exactly one OP_RETURN data output is expected; >1 is non-standard anyway.
    let payload = null, opReturnCount = 0;
    for (const out of psbt.txOutputs) {
        let decomp;
        try { decomp = bitcoin.script.decompile(out.script); } catch (e) { continue; }
        if (decomp && decomp.length === 2 &&
            decomp[0] === bitcoin.opcodes.OP_RETURN && Buffer.isBuffer(decomp[1])) {
            opReturnCount++;
            payload = decomp[1];
        }
    }
    if (opReturnCount === 0) return fail('NO_OP_RETURN');
    if (opReturnCount > 1)  return fail('MULTI_OP_RETURN');

    let plain;
    try { plain = deobfuscate(payload, firstInputTxid); }
    catch (e) { return fail('DEOBFUSCATION_FAILED', e.message); }

    if (plain.length < MAGIC_WORD.length || !plain.subarray(0, MAGIC_WORD.length).equals(MAGIC_WORD))
        return fail('NO_MAGIC_WORD');

    const body = plain.subarray(MAGIC_WORD.length);

    // P2SH/P2WSH funding tx: the OP_RETURN carries only the tag; the action
    // params live in the separate reveal tx, not in this PSBT.
    if (body.equals(P2SH_TAG) || body.equals(P2WSH_TAG)) return fail('P2SH_P2WSH_UNSUPPORTED');
    if (body.length > MAX_ACTION_DATA_LENGTH) return fail('OVERSIZED');

    // The inline payload is a compiled script push of the action-string bytes.
    let decompiled;
    try { decompiled = bitcoin.script.decompile(body); }
    catch (e) { return fail('INNER_DECOMPILE_FAILED', e.message); }
    if (!decompiled || decompiled.length === 0 || !Buffer.isBuffer(decompiled[0]))
        return fail('INNER_DECOMPILE_FAILED');

    let actionString;
    try { actionString = new TextDecoder('utf-8', { fatal: true }).decode(decompiled[0]); }
    catch (e) { return fail('NOT_UTF8'); }

    const segments = actionString.split('|');
    if (segments.length < 2) return fail('MALFORMED_ACTION_STRING');
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
    const action  = ACTION_ALIASES[rawAction] ?? rawAction;
    const version = Number(segments[1]);
    if (!Number.isInteger(version) || version < 0) return fail('BAD_VERSION');

    let fieldNames;
    try { fieldNames = FormatSelector.getFormatFields(action, version); }
    catch (e) { return fail('UNKNOWN_ACTION', `${action} v${version}`); }
    if (!Array.isArray(fieldNames) || fieldNames[0] !== 'VERSION') return fail('UNEXPECTED_FORMAT');

    // Reject variable-length (rest) fields and repeated value fields up front:
    // both are multi-value shapes the single-leg evaluator can't safely judge.
    const seen = new Set();
    for (const f of fieldNames) {
        if (FormatSelector.isRestField(f)) return fail('REST_FIELD_UNSUPPORTED', f);
        if (VALUE_FIELDS.has(f)) {
            if (seen.has(f)) return fail('MULTI_LEG_UNSUPPORTED', f);
            seen.add(f);
        }
    }

    // BATCH: parse() understands the multi-command sub-grammar, but the
    // single-leg policy evaluator cannot safely judge a command bundle, so
    // the pre-re-base fail-closed behavior is preserved verbatim: a COMMAND
    // tail with embedded '|' (every real sub-action has one) refuses with
    // the same FIELD_COUNT_MISMATCH the flat field-mapper produced.
    if (action === 'BATCH' && segments.length > 3) {
        return fail('FIELD_COUNT_MISMATCH',
            `${segments.length - 1} values vs ${fieldNames.length} fields`);
    }

    // Field extraction delegates to the canonical decoder.parse() (
    // re-base): same segment->field alignment, same trailing-empty padding,
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

    return { ok: true, action, version, params: parsed.params, actionString };
}

// MAX_ACTION_DATA_LENGTH re-exported so parity/drift guards can assert the
// co-signer gate rides the shared (chunkHelper-sourced) cap.
module.exports = { decodeActionFromPsbt, MAX_ACTION_DATA_LENGTH };
