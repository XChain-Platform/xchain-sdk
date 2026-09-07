'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// Bind the ACTION a PSBT actually carries to the action the CALLER asked for,
// at the last moment before a signature exists.
//
// reconcileEncoded.js proves the encoder's answer still spends the caller's coin
// where the caller asked: it reads outputs, values and the fee. It deliberately
// never reads the data carrier, so the one thing it cannot say is whether the
// command riding in that carrier is the command that was submitted. A
// compromised or buggy encoder can therefore keep every native output and the
// miner fee identical while swapping a SEND's amount and destination (or a
// contract action's target and arguments); the single-WIF path signed that
// substituted command and then handed the caller back the action string it had
// asked for.
//
// This module is the missing half. It is a CHECK, never a re-derivation: the
// carrier is read back out of the bytes about to be signed and compared to the
// caller's own action string. Re-deriving the expected carrier locally would
// mean a second copy of the encoder's construction plus a byte-parity gate
// forever, which verifyCarrierScripts.js already rejects by name.
//
// Fail-closed: every path either matches or throws, and "cannot read the
// carrier" throws rather than passing, because that is the exact shape of a
// guard that reports success for work it never did.

const bitcoin = require('bitcoinjs-lib');
const { SDKActionError } = require('../errors.js');
const { decodeActionStringFromPsbt, extractEnvelopeActionString } = require('../cosigner/psbtActionDecode.js');
const { verifyCarrierScripts } = require('./verifyCarrierScripts.js');
const CompressionUtils = require('../compression.js');
const { COMPRESSION_CODE_DEFLATE_RAW } = require('../protocol/constants.js');

const compressionUtils = new CompressionUtils();

// Chunk lanes: the payload rides redeem scripts no PSBT-only check can see.
const CHUNK_ENCODINGS = ['P2SH', 'P2WSH'];

// The encoder answers in PSBT HEX, so every entry point here takes either form.
// A string that will not parse yields null, and each caller decides what that
// means rather than this helper guessing.
function asPsbt(psbtOrHex, network) {
    if (!psbtOrHex) return null;
    if (typeof psbtOrHex !== 'string') return psbtOrHex;
    const opts = (network && typeof network === 'object') ? { network } : undefined;
    try { return bitcoin.Psbt.fromHex(psbtOrHex, opts); } catch (e) { return null; }
}

// Does this transaction actually contain a chunk carrier output? The check binds
// what the transaction CAN publish, not what the encoder says it built: a
// P2SH/P2WSH answer that emits no chunk output carries no action for anyone to
// substitute (and reconcileEncoded authorizes a shaped leg only on the lane that
// declares it), while one that DOES emit chunk outputs must bind them, whether or
// not the response bothered to include the scripts.
function hasChunkOutput(psbt, encoding) {
    if (!psbt || !Array.isArray(psbt.txOutputs)) return false;
    return psbt.txOutputs.some((out) => {
        let decomp;
        try { decomp = bitcoin.script.decompile(out.script); } catch (e) { return false; }
        if (!Array.isArray(decomp)) return false;
        if (encoding === 'P2SH')
            return decomp.length === 3 && decomp[0] === bitcoin.opcodes.OP_HASH160
                && Buffer.isBuffer(decomp[1]) && decomp[1].length === 20
                && decomp[2] === bitcoin.opcodes.OP_EQUAL;
        return decomp.length === 2 && decomp[0] === bitcoin.opcodes.OP_0
            && Buffer.isBuffer(decomp[1]) && decomp[1].length === 32;
    });
}

/*
 * Is the action string the transaction carries the one the caller submitted?
 *
 * Byte equality, with exactly ONE tolerated rewrite. Transparent FILE
 * compression is a deployment default on the encoder side (XCHAIN_COMPRESSION_DEFAULT,
 * ON unless an operator stages it off): when a FILE v0 payload compresses, the
 * encoder sets the action's COMPRESSION field and emits the deflated bytes, so
 * the string on chain is legitimately NOT the string submitted. Demanding raw
 * equality would deny every compressed FILE, which is a fail-closed break of a
 * shipped default-on lane rather than a safety property.
 *
 * The tolerance is deliberately one field on one action shape. COMPRESSION is a
 * FILE v0 field (withCompressionField refuses to set it on anything else), it
 * carries no value and no destination, and every other field still has to match
 * byte for byte - a SEND's amount and recipient included, which is what the
 * fund-loss substitution needs to change.
 */
function carriedActionMatches(carried, intended) {
    if (typeof carried !== 'string' || typeof intended !== 'string') return false;
    if (carried === intended) return true;
    // A caller that already declared COMPRESSION owns the field; the encoder
    // does not get to rewrite one it did not set.
    if (compressionUtils.compressionFieldOf(intended) !== '') return false;
    let compressed;
    try { compressed = compressionUtils.withCompressionField(intended, COMPRESSION_CODE_DEFLATE_RAW); }
    catch (e) { return false; }   // not a FILE v0, so no rewrite is legitimate
    return carried === compressed;
}

function mismatch(code, label, details) {
    return new SDKActionError(code,
        `${label}: the transaction does not carry the action that was submitted`, details);
}

/*
 * The inline OP_RETURN rule, applied to EVERY transaction this SDK signs
 * regardless of the encoding the encoder reported.
 *
 * Gating this on the reported encoding would be its own bypass: `encoding` is
 * the encoder's claim about its own answer, so an encoder that answers
 * "MULTISIGN" while writing an inline SEND would skip the only check that reads
 * the SEND. The rule is therefore derived from the PSBT's shape instead, and
 * the reported encoding is used only where it makes the check STRICTER.
 *
 * Exactly one lane legitimately emits an inline action carrier (Encoding.OP_RETURN),
 * and exactly one other output in the whole encoder is an OP_RETURN at all: the
 * P2SH/P2WSH reveal's tag marker, which carries "XCHNp2sh"/"XCHNp2wsh" and no
 * params. MULTISIGN, the chunk funding transaction and the envelope commit emit
 * no OP_RETURN whatsoever. So a decode that recovers an action string must
 * match, the tag is skipped, and everything else fails closed.
 */
function assertInlineCarrier({ psbt, actionString, encoding, network, label }) {
    const decoded = decodeActionStringFromPsbt(psbt, network ? { network } : {});
    if (decoded.ok) {
        if (!carriedActionMatches(decoded.actionString, actionString))
            throw mismatch('CARRIER_ACTION_MISMATCH', label,
                { submitted: actionString, carried: decoded.actionString });
        return;
    }
    // A SECOND well-formed carrier is the one unreadable shape that must still
    // deny. Two carriers are two commands, only one of which was authorized, and
    // which one the chain executes is not this SDK's call to make: the encoder
    // never emits two (its own single-OP_RETURN policy throws first, and no
    // shipped coin relays multi-OP_RETURN as standard), so refusing costs nothing
    // real.
    if (decoded.reason === 'MULTI_OP_RETURN')
        throw mismatch('CARRIER_UNREADABLE', label,
            { submitted: actionString, reason: decoded.reason, detail: decoded.detail });
    // Every other decode failure means this transaction carries no readable inline
    // action: the P2SH/P2WSH reveal's tag marker (a tag, no params), no OP_RETURN
    // at all on the chunk funding transaction, MULTISIGN and the envelope commit,
    // or bytes that do not deobfuscate to the magic word and will not decompile.
    // This decoder mirrors the authoritative one (same obfuscation derivation,
    // same magic word, same single-push count), so what it cannot read is what the
    // chain reads no action out of - which is a transaction that publishes
    // nothing, not a substituted command. Bounding the check to what the chain can
    // actually execute is what keeps it a fund-safety gate rather than a second,
    // stricter opinion about the encoder's framing.
    return;
}

/*
 * Bind one PSBT about to be signed to `actionString`.
 *
 * @param {object}   args
 * @param {object}   args.psbt            the bitcoinjs Psbt about to be signed
 * @param {string}   args.actionString    the action the caller submitted
 * @param {string}   [args.encoding]      the encoder-reported encoding (used only to tighten)
 * @param {string[]} [args.carrierScripts] chunk redeem scripts, as create_tx returned them
 * @param {object}   [args.network]       bitcoinjs network
 * @param {string}   [args.label]         which transaction this is, for the error
 * @throws {SDKActionError} CARRIER_ACTION_MISMATCH / CARRIER_UNREADABLE
 */
function assertCarrierBinding({ psbt, actionString, encoding, carrierScripts, network, label = 'transaction' }) {
    if (typeof actionString !== 'string' || actionString.length === 0)
        throw new SDKActionError('CARRIER_BIND_MISSING_ACTION',
            `${label}: cannot bind a carrier without the caller's action string`);

    assertInlineCarrier({ psbt, actionString, encoding, network, label });

    // The chunk lanes carry the LARGEST payloads inside redeem scripts, so no
    // PSBT-only check can see them. verifyCarrierScripts hashes the scripts the
    // encoder committed to against outputs actually present here AND reads the
    // payload back out of them, so a forged script has to survive both.
    const enc = String(encoding || '').toUpperCase();
    if (!CHUNK_ENCODINGS.includes(enc)) return;
    if (!hasChunkOutput(asPsbt(psbt, network), enc)) return;
    const verified = verifyCarrierScripts({ psbt, carrierScripts, encoding: enc, actionString, network });
    if (verified && verified.ok === true) return;
    // SCRIPTS_MISSING lands here too, and deliberately: an encoder that returns no
    // carrier scripts leaves the largest payloads unverifiable, and "cannot check"
    // is not "checked", so the absent evidence fails the binding rather than passing it.
    throw mismatch('CARRIER_ACTION_MISMATCH', label,
        { submitted: actionString, encoding: enc, reason: verified ? verified.reason : 'NO_RESULT' });
}

/*
 * Bind a Taproot envelope REVEAL to `actionString`.
 *
 * The reveal is where the envelope's action bytes first appear in a transaction
 * (the commit output is only a hash of the leaf), and the SDK signs it while
 * nothing is on chain yet, so a substituted reveal costs a throw here instead of
 * a stranded commit later.
 */
function assertEnvelopeCarrierBinding({ revealPsbt, actionString, network, label = 'envelope reveal' }) {
    if (typeof actionString !== 'string' || actionString.length === 0)
        throw new SDKActionError('CARRIER_BIND_MISSING_ACTION',
            `${label}: cannot bind a carrier without the caller's action string`);
    // create_tx answers in hex; extractEnvelopeActionString reads a parsed PSBT and
    // reports a hex string as NO_INPUTS, which would have made this guard deny every
    // real reveal.
    const parsed = asPsbt(revealPsbt, network);
    if (!parsed)
        throw mismatch('CARRIER_UNREADABLE', label, { submitted: actionString, reason: 'PSBT_PARSE_FAILED' });
    const extracted = extractEnvelopeActionString(parsed);
    if (!extracted.ok)
        throw mismatch('CARRIER_UNREADABLE', label,
            { submitted: actionString, reason: extracted.reason, detail: extracted.detail });
    if (!carriedActionMatches(extracted.actionString, actionString))
        throw mismatch('CARRIER_ACTION_MISMATCH', label,
            { submitted: actionString, carried: extracted.actionString });
}

module.exports = { assertCarrierBinding, assertEnvelopeCarrierBinding, carriedActionMatches };
