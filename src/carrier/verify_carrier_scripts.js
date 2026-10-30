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
// Carrier-script verification for the P2SH / P2WSH chunk lanes.
//
// An inline OP_RETURN action can be read back out of the PSBT and compared
// to what the caller asked for (`decodeActionFromPsbt`). A chunked action
// cannot: its payload lives in redeem scripts that exist only inside the
// encoder, and the commit outputs are just hashes of them. So the one
// encoding that carries the LARGEST payloads was also the one the wallet
// had to take on trust: a compromised encoder could swap the payload while
// leaving the signer to approve only its opaque hash. Checking both the script
// commitment and its content closes that gap on the signing side.
//
// The encoder now returns those scripts (`carrierScripts`). Verification is
// therefore a check, not a re-derivation - deliberately, because a second
// copy of the encoder's script construction would need a byte-parity gate
// forever and would drift the moment the encoder changed.
//
// Two checks, and a forged script has to survive BOTH:
//
//   1. BINDING - each script hashes to a P2SH/P2WSH output actually present
//      in the PSBT. A script the encoder invented but did not commit to
//      fails here.
//   2. CONTENT - the leading data pushes, concatenated in order, are exactly
//      the action bytes the caller intended, and the rawData push (FILE,
//      artwork or label bytes, or gated ciphertext) is the caller's rawData
//      when the caller passes it. A script that IS committed but carries a
//      different payload fails here.
//
// Check 1 alone would accept a faithful hash of the wrong payload; check 2
// alone would accept the right payload in a script that is not the one being
// signed. Neither is sufficient, which is why both are mandatory and why
// this refuses rather than warns when it cannot run.

const bitcoin = require('bitcoinjs-lib');
const zlib = require('zlib');
const { isBytes, toBuffer, bytesEqual } = require('../utils/bytes');
const { getNetwork } = require('../protocol/networks.js');

const CHUNK_ENCODINGS = ['P2SH', 'P2WSH'];

// Reasons are returned rather than thrown: the caller (the wallet's tamper
// check) decides the severity, and a blocking error there is a better UX
// than an exception escaping a compose path.
const REASONS = {
    NOT_CHUNKED:        'NOT_CHUNKED',
    SCRIPTS_MISSING:    'SCRIPTS_MISSING',
    SCRIPT_UNPARSEABLE: 'SCRIPT_UNPARSEABLE',
    OUTPUT_NOT_FOUND:   'OUTPUT_NOT_FOUND',
    PAYLOAD_MISMATCH:   'PAYLOAD_MISMATCH',
    SEGWIT_UNSUPPORTED: 'SEGWIT_UNSUPPORTED',
};

// Resolve the caller's network: a bitcoinjs network object as given, a known name
// through the coin registry, and anything else as bitcoin. Callers pass sdk.config.network,
// a NAME such as 'litecoin-regtest', as readily as an object, and payments only ever see an object.
function resolveNetwork(network) {
    if (network && typeof network === 'object' && network.pubKeyHash !== undefined) return network;
    if (typeof network === 'string' && network.length) {
        try { return getNetwork(network); } catch (e) { /* unknown name: bitcoin below */ }
    }
    return bitcoin.networks.bitcoin;
}

// Accepts a PSBT as hex/base64 (the shape that survives the wallet's host
// messaging boundary) or as an already-parsed bitcoinjs Psbt. Reads the
// underlying tx rather than psbt.data.outputs, because the output SCRIPT is
// what actually gets committed to and that lives on the tx.
function outputScriptsOf(psbt) {
    if (!psbt) return [];
    let p = psbt;
    if (typeof psbt === 'string') {
        const s = psbt.trim();
        try {
            p = /^[0-9a-fA-F]+$/.test(s) ? bitcoin.Psbt.fromHex(s) : bitcoin.Psbt.fromBase64(s);
        } catch (e) { return []; }
    }
    const tx = p.__CACHE && p.__CACHE.__TX ? p.__CACHE.__TX : null;
    if (tx && Array.isArray(tx.outs)) return tx.outs.map(o => o.script);
    // Fall back to a plain {outputs:[{script}]} shape (a decomposed PSBT),
    // accepting hex strings for the script as well as buffers.
    const outs = Array.isArray(p.outputs) ? p.outputs : [];
    return outs.map(o => {
        const s = o && o.script;
        if (isBytes(s)) return s;
        if (typeof s === 'string') { try { return Buffer.from(s, 'hex'); } catch (e) { return null; } }
        return null;
    }).filter(Boolean);
}

// The committed output script for a redeem script, per encoding. p2sh wraps
// in HASH160, p2wsh in SHA256; using the library's own payments keeps this a
// hash of the encoder's bytes rather than a second opinion about them.
function committedScriptFor(encoding, redeem, network) {
    if (encoding === 'P2SH')
        return bitcoin.payments.p2sh({ redeem: { output: redeem }, network }).output;
    return bitcoin.payments.p2wsh({ redeem: { output: redeem }, network }).output;
}

// The data chunk is the LEADING push of the redeem script; everything after
// it is the P2PKH spend gate (OP_DROP OP_DUP OP_HASH160 <h160> OP_EQUALVERIFY
// OP_CHECKSIG). A script whose first element is not a Buffer carries no data
// chunk, which is the same condition the decoder skips on.
function chunkOf(redeem) {
    let decompiled;
    try { decompiled = bitcoin.script.decompile(redeem); } catch (e) { return null; }
    if (!Array.isArray(decompiled) || !decompiled.length) return null;
    return isBytes(decompiled[0]) ? toBuffer(decompiled[0]) : null;
}

function verifiedChunks(carrierScripts, enc, net, present) {
    const chunks = [];
    for (const hex of carrierScripts) {
        let redeem;
        try { redeem = Buffer.from(String(hex), 'hex'); } catch (e) { redeem = null; }
        if (!redeem || !redeem.length)
            return { ok: false, reason: REASONS.SCRIPT_UNPARSEABLE, checked: chunks.length };

        // [1] BINDING
        let committed;
        try { committed = committedScriptFor(enc, redeem, net); }
        catch (e) { return { ok: false, reason: REASONS.SCRIPT_UNPARSEABLE, checked: chunks.length }; }
        if (!present.some(s => bytesEqual(s, committed)))
            return { ok: false, reason: REASONS.OUTPUT_NOT_FOUND, checked: chunks.length };

        const chunk = chunkOf(redeem);
        if (!chunk)
            return { ok: false, reason: REASONS.SCRIPT_UNPARSEABLE, checked: chunks.length };
        chunks.push(chunk);
    }
    return chunks;
}

// A push the compiler minimized to an opcode carries bytes too; OP_0 is the empty payload.
function pushBytes(el) {
    if (isBytes(el)) return toBuffer(el);
    return el === bitcoin.opcodes.OP_0 ? Buffer.alloc(0) : null;
}

// Match the rawData push to the caller's latin-1 bytes; a compressed push must be shorter and
// inflate, capped at their length, to exactly them (the encoder compresses only to save bytes).
function rawDataMatches(pushes, rawData, rawDataCompressed) {
    if (rawData === undefined) return true;
    if (rawData === null) return pushes.length === 1;
    const carried = pushes.length === 2 ? pushBytes(pushes[1]) : null;
    if (!carried) return false;
    const expected = isBytes(rawData) ? toBuffer(rawData) : Buffer.from(String(rawData), 'binary');
    if (rawDataCompressed !== true) return carried.equals(expected);
    if (!expected.length || carried.length >= expected.length) return false;
    try { return zlib.inflateRawSync(carried, { maxOutputLength: expected.length }).equals(expected); }
    catch (e) { return false; }
}

/**
 * @param {object}   args
 * @param {object}   args.psbt            a bitcoinjs Psbt (the one about to be signed)
 * @param {string[]} args.carrierScripts  hex redeem scripts, as create_tx returned them
 * @param {string}   args.encoding        the encoder-reported encoding
 * @param {string}   args.actionString    the action the caller intended to send
 * @param {string|Buffer|null} [args.rawData] the rawData the caller gave the encoder; null
 *                                        demands no rawData push, omitted leaves it unchecked
 * @param {boolean}  [args.rawDataCompressed] the push is the deflate-raw form of rawData
 * @param {object}   [args.network]       bitcoinjs network (defaults to bitcoin)
 * @returns {{ok: boolean, reason: string|null, checked: number}}
 */
function verifyCarrierScripts({ psbt, carrierScripts, encoding, actionString, rawData, rawDataCompressed, network } = {}) {
    const enc = String(encoding || '').toUpperCase();
    // Not a chunk lane: nothing here to verify, and saying so is not a pass.
    // The caller keeps using decodeActionFromPsbt for inline OP_RETURN.
    if (!CHUNK_ENCODINGS.includes(enc))
        return { ok: true, reason: REASONS.NOT_CHUNKED, checked: 0 };

    // Refuse P2WSH on a chain without segwit, as the encoder and decoder do (`=== false`:
    // native bitcoinjs networks lack the field). The committed output SCRIPT is a bare hash
    // push, identical on every network, so legality of the lane is all the network decides.
    const net = resolveNetwork(network);
    if (enc === 'P2WSH' && net.supportsSegwit === false)
        return { ok: false, reason: REASONS.SEGWIT_UNSUPPORTED, checked: 0 };

    // A chunked encoding with no scripts is an encoder that predates
    // carrier-script support, or a stripped response. Fail closed: this is
    // exactly the case that used to be silently trusted, so treating
    // "cannot check" as "fine" would reintroduce the gap it exists to close.
    if (!Array.isArray(carrierScripts) || !carrierScripts.length)
        return { ok: false, reason: REASONS.SCRIPTS_MISSING, checked: 0 };

    const present = outputScriptsOf(psbt);
    const chunks = verifiedChunks(carrierScripts, enc, net, present);
    if (!Array.isArray(chunks)) return chunks;

    // [2] CONTENT. Chunks concatenate in the order the encoder emitted them,
    // which is the order the decoder reassembles them in.
    //
    // What they concatenate INTO is a compiled script, not the bare action:
    // the encoder chunks `script.compile([action])` (plus a second push for a
    // rawData payload), so the reassembled bytes carry the push prefix - 0x4c
    // 0x9a ahead of a 154-byte SEND, for instance. The decoder strips it by
    // decompiling the reassembly and reading push[0] (XChainDecoder.js), so
    // that is what this mirrors. Comparing the raw concatenation to the action
    // string instead made every real chunked action look tampered: it was
    // PAYLOAD_MISMATCH for a correctly encoded three-recipient SEND on
    // regtest, and the wallet's confirm surface refused to open.
    // The fixtures here had the same gap in mirror image, which is why no test
    // caught it - they compiled the chunks from the bare action bytes, a shape
    // the encoder never emits.
    const carried = Buffer.concat(chunks);
    let payload, pushes;
    try {
        pushes = bitcoin.script.decompile(carried);
        payload = Array.isArray(pushes) && isBytes(pushes[0]) ? toBuffer(pushes[0]) : null;
    } catch (e) { payload = null; }
    // Not a decodable push: the chain would read no action out of these bytes
    // at all, so this is a mismatch rather than a pass.
    if (!payload)
        return { ok: false, reason: REASONS.PAYLOAD_MISMATCH, checked: chunks.length };

    const intended = Buffer.from(String(actionString == null ? '' : actionString), 'utf8');
    if (!payload.equals(intended) || !rawDataMatches(pushes, rawData, rawDataCompressed))
        return { ok: false, reason: REASONS.PAYLOAD_MISMATCH, checked: chunks.length };

    return { ok: true, reason: null, checked: chunks.length };
}

module.exports = { verifyCarrierScripts, rawDataMatches, REASONS, CHUNK_ENCODINGS };
