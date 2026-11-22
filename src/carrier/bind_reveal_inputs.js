/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

const bitcoin = require('bitcoinjs-lib');
const { SDKActionError } = require('../utils/errors.js');
const { committedScriptFor } = require('./verify_carrier_scripts.js');
const { bytesEqual } = require('../utils/bytes');

// A P2SH/P2WSH chunk reveal is decoded by concatenating the leading push of every
// input's redeem or witness script in input order, whatever each input spends. The
// carrier scripts phase 1 verified are therefore the only data-bearing inputs the
// reveal may hold: the same scripts, in the same order, each spending the signed
// commit's output that commits to it, and nothing already signed that a finalizer
// would accept as it stands. Checked before the reveal is signed, so a refusal
// leaves the signed commit unbroadcast.

const CHUNK_ENCODINGS = ['P2SH', 'P2WSH'];
const SCRIPT_FIELD = { P2SH: 'redeemScript', P2WSH: 'witnessScript' };
const OTHER_FIELD = { P2SH: 'witnessScript', P2WSH: 'redeemScript' };

function refusal(label, reason, inputIndex) {
    return new SDKActionError('REVEAL_INPUTS_REFUSED',
        `${label}: the reveal's inputs are not the verified carrier legs of the signed commit (${reason})`,
        { reason, inputIndex });
}

function filled(list) { return Array.isArray(list) && list.length > 0; }

function isPresigned(data) {
    return filled(data.partialSig) || filled(data.tapScriptSig) || !!data.finalScriptSig
        || !!data.finalScriptWitness || !!data.tapKeySig;
}

function parseOrRefuse(label, reason, parse) {
    try { return parse(); } catch (e) { throw refusal(label, reason, null); }
}

function expectedScripts(carrierScripts, label) {
    const list = Array.isArray(carrierScripts) ? carrierScripts : [];
    return list.map((hex) => {
        if (typeof hex !== 'string' || hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex))
            throw refusal(label, 'CARRIER_SCRIPTS_INVALID', null);
        return Buffer.from(hex, 'hex');
    });
}

function assertLegInput({ reveal, commit, data, index, want, enc, network, label, spent }) {
    const input = reveal.txInputs[index];
    if (!want) throw refusal(label, 'EXTRA_DATA_INPUT', index);
    if (!bytesEqual(input.hash, commit.getHash())) throw refusal(label, 'INPUT_NOT_FROM_COMMIT', index);
    const output = commit.outs[input.index];
    if (!output || spent.has(input.index)) throw refusal(label, 'INPUT_OUTPOINT_INVALID', index);
    spent.add(input.index);
    if (!bytesEqual(output.script, committedScriptFor(enc, want, network)))
        throw refusal(label, 'INPUT_OUTPUT_NOT_COMMITTED_TO_SCRIPT', index);
    if (!bytesEqual(data[SCRIPT_FIELD[enc]], want) || data[OTHER_FIELD[enc]])
        throw refusal(label, 'INPUT_SCRIPT_MISMATCH', index);
}

// Throws REVEAL_INPUTS_REFUSED unless every data-bearing input of the reveal is the
// next verified carrier script, in order, and no input arrives already signed.
function assertRevealInputsBound({ psbt, commitTxHex, carrierScripts, encoding, network, label = 'phase-2 reveal' }) {
    const enc = String(encoding || '').toUpperCase();
    if (!CHUNK_ENCODINGS.includes(enc)) throw refusal(label, 'ENCODING_NOT_CHUNKED', null);
    const reveal = parseOrRefuse(label, 'REVEAL_UNREADABLE', () => (typeof psbt === 'string'
        ? bitcoin.Psbt.fromHex(psbt, { network }) : psbt));
    const commit = parseOrRefuse(label, 'COMMIT_UNREADABLE', () => bitcoin.Transaction.fromHex(commitTxHex));
    const expected = expectedScripts(carrierScripts, label);
    const spent = new Set();
    let next = 0;
    reveal.data.inputs.forEach((data, index) => {
        if (isPresigned(data)) throw refusal(label, 'PRESIGNED_INPUT', index);
        if (!data.redeemScript && !data.witnessScript) return;
        assertLegInput({ reveal, commit, data, index, want: expected[next], enc, network, label, spent });
        next += 1;
    });
    if (next !== expected.length) throw refusal(label, 'CARRIER_LEG_NOT_SPENT', null);
}

module.exports = { assertRevealInputsBound };
