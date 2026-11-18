/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

const bitcoin = require('bitcoinjs-lib');
const { deriveEnvelopeCommit } = require('../cosigner/envelope.js');
const { SDKActionError } = require('../utils/errors.js');
const { bytesEqual } = require('../utils/bytes');

// What the caller already knows about an honest two-step commit before it signs
// one: the commit spends exactly the funding output the piece was planned on, and
// it pays exactly one output, the Taproot commit address derived locally from the
// caller's key and the envelope leaf the encoder reports. Anything else is an
// encoder-chosen input or destination, so it is refused before a signature exists.

function commitRefusal(reason, detail) {
    return new SDKActionError('ENVELOPE_COMMIT_MISMATCH',
        'multipart envelope commit pre-sign: the encoder commit is not the one requested',
        { reason, detail });
}

function parseCommit(commit, network) {
    try { return bitcoin.Psbt.fromHex(commit.psbt, { network }); }
    catch (e) { throw commitRefusal('PSBT_PARSE_FAILED', e.message); }
}

function leafOf(commit) {
    const scripts = commit && commit.carrierScripts;
    if (!Array.isArray(scripts) || scripts.length !== 1 || typeof scripts[0] !== 'string'
        || scripts[0].length === 0 || scripts[0].length % 2 !== 0 || !/^[0-9a-f]+$/i.test(scripts[0]))
        throw commitRefusal('CARRIER_SCRIPTS_INVALID');
    return Buffer.from(scripts[0], 'hex');
}

function assertSingleInput(psbt, utxo) {
    if (psbt.txInputs.length !== 1) throw commitRefusal('INPUT_COUNT', psbt.txInputs.length);
    const input = psbt.txInputs[0];
    const txid = Buffer.from(input.hash).reverse().toString('hex');
    if (txid !== String(utxo.txid).toLowerCase() || input.index !== utxo.vout)
        throw commitRefusal('INPUT_OUTPOINT_MISMATCH', `${txid}:${input.index}`);
}

function commitOutputOf(psbt, derived) {
    const matches = psbt.txOutputs.filter(out => bytesEqual(out.script, derived.output));
    if (matches.length !== 1) throw commitRefusal('COMMIT_OUTPUT_COUNT', matches.length);
    return matches[0];
}

// Returns the reconcile pins and the signing scope for the commit PSBT, or throws.
function twoStepCommitPins({ commit, utxo, callerXOnly, network }) {
    const psbt = parseCommit(commit, network);
    assertSingleInput(psbt, utxo);
    let derived;
    try { derived = deriveEnvelopeCommit({ internalXOnly: callerXOnly, envelopeScript: leafOf(commit), network }); }
    catch (e) {
        if (e instanceof SDKActionError) throw e;
        throw commitRefusal('CALLER_KEY_MISMATCH', e.message);
    }
    const output = commitOutputOf(psbt, derived);
    return {
        inputIndices: [0],
        phaseSpends: [{ script: derived.output, value: BigInt(output.value) }],
        requiredSpends: [{ script: Buffer.from(utxo.scriptPubKey, 'hex'), value: BigInt(utxo.value) }],
    };
}

module.exports = { twoStepCommitPins };
