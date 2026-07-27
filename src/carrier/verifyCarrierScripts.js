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
// Carrier-script verification for the P2SH / P2WSH chunk lanes
// (confirm/decode/pre-flight spec §5.3.2, closing the §1 residual).
//
// An inline OP_RETURN action can be read back out of the PSBT and compared
// to what the caller asked for (`decodeActionFromPsbt`). A chunked action
// cannot: its payload lives in redeem scripts that exist only inside the
// encoder, and the commit outputs are just hashes of them. So the one
// encoding that carries the LARGEST payloads was also the one the wallet
// had to take on trust, and §1 recorded that as residual encoder trust.
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
//      the action bytes the caller intended. A script that IS committed but
//      carries a different payload fails here.
//
// Check 1 alone would accept a faithful hash of the wrong payload; check 2
// alone would accept the right payload in a script that is not the one being
// signed. Neither is sufficient, which is why both are mandatory and why
// this refuses rather than warns when it cannot run.

const bitcoin = require('bitcoinjs-lib');

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
};

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
        if (Buffer.isBuffer(s)) return s;
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
    return Buffer.isBuffer(decompiled[0]) ? decompiled[0] : null;
}

/**
 * @param {object}   args
 * @param {object}   args.psbt            a bitcoinjs Psbt (the one about to be signed)
 * @param {string[]} args.carrierScripts  hex redeem scripts, as create_tx returned them
 * @param {string}   args.encoding        the encoder-reported encoding
 * @param {string}   args.actionString    the action the caller intended to send
 * @param {object}   [args.network]       bitcoinjs network (defaults to bitcoin)
 * @returns {{ok: boolean, reason: string|null, checked: number}}
 */
function verifyCarrierScripts({ psbt, carrierScripts, encoding, actionString, network } = {}) {
    const enc = String(encoding || '').toUpperCase();
    // Not a chunk lane: nothing here to verify, and saying so is not a pass.
    // The caller keeps using decodeActionFromPsbt for inline OP_RETURN.
    if (!CHUNK_ENCODINGS.includes(enc))
        return { ok: true, reason: REASONS.NOT_CHUNKED, checked: 0 };

    // A chunked encoding with no scripts is the pre- encoder, or a
    // stripped response. Fail closed: this is exactly the case that used to
    // be silently trusted, so treating "cannot check" as "fine" would
    // reintroduce the gap it exists to close.
    if (!Array.isArray(carrierScripts) || !carrierScripts.length)
        return { ok: false, reason: REASONS.SCRIPTS_MISSING, checked: 0 };

    // Callers reasonably pass sdk.config.network, which is a NAME ('bitcoin',
    // 'litecoin-regtest'), not a bitcoinjs network object. Only a real network
    // object is forwarded to payments. This affects nothing either way - the
    // P2SH/P2WSH output SCRIPT is a bare hash push, identical on every network
    // (only the derived ADDRESS is network-specific, and it is not used here) -
    // but a string reaching payments is a trap waiting for a future change.
    const net = (network && typeof network === 'object' && network.pubKeyHash !== undefined)
        ? network
        : bitcoin.networks.bitcoin;
    const present = outputScriptsOf(psbt);
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
        if (!present.some(s => Buffer.isBuffer(s) && s.equals(committed)))
            return { ok: false, reason: REASONS.OUTPUT_NOT_FOUND, checked: chunks.length };

        const chunk = chunkOf(redeem);
        if (!chunk)
            return { ok: false, reason: REASONS.SCRIPT_UNPARSEABLE, checked: chunks.length };
        chunks.push(chunk);
    }

    // [2] CONTENT. Chunks concatenate in the order the encoder emitted them,
    // which is the order the decoder reassembles them in.
    const carried = Buffer.concat(chunks);
    const intended = Buffer.from(String(actionString == null ? '' : actionString), 'utf8');
    if (!carried.equals(intended))
        return { ok: false, reason: REASONS.PAYLOAD_MISMATCH, checked: chunks.length };

    return { ok: true, reason: null, checked: chunks.length };
}

module.exports = { verifyCarrierScripts, REASONS, CHUNK_ENCODINGS };
