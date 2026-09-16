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

const crypto = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const { envelopeLeafFromPsbtInput } = require('../envelope.js');
const { ENVELOPE_MAX_PAYLOAD } = require('../../protocol/constants.js');
const { MAX_ACTION_DATA_LENGTH } = require('../../contract/chunk_helper.js');

function fail(reason, detail) { return { ok: false, reason, detail: detail || null }; }

// Mirror xchain-decoder/src/XChainDecoder.js:44-63. The action-data cap is
// imported from chunk_helper.js (the SDK's single parity-guarded copy) so the
// co-signer's OVERSIZED gate cannot drift from the rest of the SDK.
//
// These carrier constants are re-declared rather than imported because the
// arbiter is service-bound (see the file header), so they are pinned instead by
// test/unit/cosigner_roundtrip_conformance.test.js, which decodes the SHARED
// encoder->decoder roundtrip-conformance fixture through this module. If the
// encoder/decoder ever changes the magic word, the P2SH/P2WSH tags or the
// key/IV derivation, the regenerated fixture stops decoding here and that test
// fails, instead of hardware co-signer decode silently breaking in the field.
const MAGIC_WORD = Buffer.from('XCHN');
const P2SH_TAG   = Buffer.from('p2sh');
const P2WSH_TAG  = Buffer.from('p2wsh');

// AES-128-CTR de-obfuscation, key/iv = first 16 / next 16 hex chars of the
// first input's txid. Verbatim from XChainDecoder.removeObfuscation (and the
// inverse of XChainEncoder.obfuscate). The derivation lives in this one frozen
// descriptor so the conformance test can assert against the code that actually
// runs rather than against a second copy of the offsets.
const OBFUSCATION = Object.freeze({
    algorithm: 'aes-128-ctr',
    keyOffset: 0,  keyLength: 16,
    ivOffset:  16, ivLength:  16,
});

function deobfuscate(data, txidHex) {
    const key = txidHex.substr(OBFUSCATION.keyOffset, OBFUSCATION.keyLength);
    const iv  = txidHex.substr(OBFUSCATION.ivOffset,  OBFUSCATION.ivLength);
    const d   = crypto.createDecipheriv(OBFUSCATION.algorithm, key, iv);
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
// Recover ONLY the raw inline OP_RETURN action-string bytes from a PSBT, exactly
// as the encoder wrote them, with NO format/field/rest/multi-leg judgment. This
// is the pure byte-recovery half shared by both public decoders (deobfuscate ->
// magic word -> inline script push -> utf8). It fails closed on anything that is
// not a single well-formed inline OP_RETURN action payload (no/multi OP_RETURN,
// the P2SH/P2WSH two-phase tag, oversized, decompile or utf8 failure). Callers
// that need policy judgment layer the format/rest/multi-leg gates on top.
//
// @returns { ok:true, actionString } | { ok:false, reason, detail }
function extractInlineActionString(psbtOrHex, opts = {}) {
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

    return { ok: true, actionString };
}

/*
 * Recover the action-string bytes from a Taproot ENVELOPE reveal PSBT
 * (§3.9 delta c). The envelope carries the action in input 0's tapleaf
 * script instead of an OP_RETURN, and carries it RAW (§3.3: there is no
 * deobfuscation step for the envelope, and none is possible - the key would be
 * the commit txid, which the commit output's own contents determine).
 *
 * The refusals below mirror the authoritative decoder's §3.8 arbitration
 * exactly, because a co-signer that read an action the chain will not execute
 * (or missed one it will) is the whole failure mode this decoder exists to
 * avoid: an envelope anywhere other than input 0, more than one envelope
 * input, or an envelope mixed with any OP_RETURN carrier is NOT an action.
 *
 * @returns { ok:true, actionString } | { ok:false, reason, detail }
 */
function extractEnvelopeActionString(psbt) {
    if (!psbt || !psbt.data || !Array.isArray(psbt.data.inputs) || psbt.data.inputs.length === 0)
        return fail('NO_INPUTS');

    const envelopeIndexes = [];
    for (let i = 0; i < psbt.data.inputs.length; i++) {
        if (envelopeLeafFromPsbtInput(psbt.data.inputs[i])) envelopeIndexes.push(i);
    }
    if (envelopeIndexes.length === 0) return fail('NO_ENVELOPE');
    // Both are deterministic no-action outcomes on chain (§3.8), so they must be
    // refusals here rather than a decode of whichever one we happened to find.
    if (envelopeIndexes.length > 1) return fail('MULTI_ENVELOPE');
    if (envelopeIndexes[0] !== 0) return fail('ENVELOPE_NOT_INPUT_ZERO');

    // Mixed carriers are no-action on chain. Any OP_RETURN output at all is
    // refused here rather than only an XCHN-magic one: the co-signer's job is to
    // be a strict subset of the decoder, and refusing more is always safe.
    for (const out of psbt.txOutputs) {
        let decomp;
        try { decomp = bitcoin.script.decompile(out.script); } catch (e) { continue; }
        if (decomp && decomp.length >= 1 && decomp[0] === bitcoin.opcodes.OP_RETURN)
            return fail('ENVELOPE_MIXED_CARRIER');
    }

    const leaf = envelopeLeafFromPsbtInput(psbt.data.inputs[0]);
    if (leaf.payload.length > ENVELOPE_MAX_PAYLOAD) return fail('OVERSIZED');

    // The payload is the compiled data stream: the action-string push, then the
    // rawData push. Identical to what the decoder decompiles (XChainDecoder.js:
    // `dataBuffer = envelopeInputs[0].payload`, feeding the shared decompile).
    let decompiled;
    try { decompiled = bitcoin.script.decompile(leaf.payload); }
    catch (e) { return fail('INNER_DECOMPILE_FAILED', e.message); }
    if (!decompiled || decompiled.length === 0 || !Buffer.isBuffer(decompiled[0]))
        return fail('INNER_DECOMPILE_FAILED');

    let actionString;
    try { actionString = new TextDecoder('utf-8', { fatal: true }).decode(decompiled[0]); }
    catch (e) { return fail('NOT_UTF8'); }

    return { ok: true, actionString, envelope: leaf };
}

module.exports = { fail, MAGIC_WORD, P2SH_TAG, P2WSH_TAG, OBFUSCATION,
                   deobfuscate, extractInlineActionString, extractEnvelopeActionString };
