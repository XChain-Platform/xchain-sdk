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

// Mirror xchain-decoder/src/XChainDecoder.js:44-63.
const MAGIC_WORD = Buffer.from('XCHN');
const P2SH_TAG   = Buffer.from('p2sh');
const P2WSH_TAG  = Buffer.from('p2wsh');
const MAX_ACTION_DATA_LENGTH = 8192;

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
    const action  = String(segments[0]).toUpperCase();
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

    // Map fields -> segments. segments[0] is the action name; fieldNames[i]
    // aligns with segments[1+i] (fieldNames[0]=='VERSION'==segments[1]). The
    // encoder trims trailing empty fields (formatSelector.serialize), so fewer
    // segments than fields is normal - pad the tail with ''. More segments than
    // fields (and no rest-field) is malformed -> fail closed.
    const valueSegs = segments.slice(1);
    if (valueSegs.length > fieldNames.length) return fail('FIELD_COUNT_MISMATCH',
        `${valueSegs.length} values vs ${fieldNames.length} fields`);

    const params = {};
    for (let i = 0; i < fieldNames.length; i++) {
        const name = fieldNames[i];
        if (name === 'VERSION') continue;
        params[name] = (i < valueSegs.length) ? valueSegs[i] : '';
    }

    return { ok: true, action, version, params, actionString };
}

module.exports = { decodeActionFromPsbt };
