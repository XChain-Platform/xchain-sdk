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
 *********************************************************************/

'use strict';

const bitcoin = require('bitcoinjs-lib');
const { findVerifiedPrevout } = require('../../utils/wallet/psbt_prevout.js');

// Satoshi values arrive as Number OR BigInt: applyBufferutilsPatch teaches
// bip174/bitcoinjs to carry values above 2^53-1 (large DOGE UTXOs) as BigInt.
// All arithmetic here is BigInt so a >2^53 value is neither rejected nor rounded.
function toU64(v) {
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return BigInt(v);
    return null;
}

// Same, plus the decimal-STRING form. A caller-supplied cap in intent.customOutputs
// may legitimately arrive as a string (that is what the encoder's parseSatoshiAmount
// allowBig path exists for), and a Number() hop before toU64 rounds it away above
// 2^53. Mirrors cosigner exactU64.
//
// SAFE integer, not merely integer. A Number above 2^53-1 has ALREADY lost precision
// before this function sees it, so BigInt-converting it launders a rounded value into
// a cap that is then compared exactly, the very defect the bigint and digit-string
// branches exist to avoid. A cap that large must arrive as one of those two forms; a
// bare Number is refused, and every caller fails closed on the null (see
// MALFORMED_FEE_CAP / MALFORMED_PHASE_FUNDING_CAP).
function exactU64(v) {
    if (typeof v === 'bigint') return v >= 0n ? v : null;
    if (typeof v === 'number') return (Number.isSafeInteger(v) && v >= 0) ? BigInt(v) : null;
    if (typeof v === 'string' && /^\d+$/.test(v.trim())) return BigInt(v.trim());
    return null;
}

// Read the verified prevout, folding an untrustworthy one into null so every caller fails closed.
function verifiedPrevoutOrNull(psbt, i) {
    try { return findVerifiedPrevout(psbt, i); } catch (e) { return null; }
}

// The output script an input spends, resolved the way bitcoinjs signs it (hash-checked
// nonWitnessUtxo first, never a disagreeing witnessUtxo). An input with no usable UTXO
// form cannot be signed, so the fail-closed path below is not a false positive.
function inputScript(psbt, i) {
    const prevout = verifiedPrevoutOrNull(psbt, i);
    return prevout ? prevout.script : null;
}

// The value an input brings in, from the same verified prevout.
function inputValue(psbt, i) {
    const prevout = verifiedPrevoutOrNull(psbt, i);
    return prevout ? toU64(prevout.value) : null;
}

// Report whether another party already signed this input; the encoder's answer is unsigned.
// Unsigned does not prove ownership: a shared-key script the WIF can finalize may be foreign.
function inputPresigned(psbt, i) {
    const data = psbt.data.inputs[i];
    if (!data) return false;
    return !!(data.finalScriptSig || data.finalScriptWitness
        || (Array.isArray(data.partialSig) && data.partialSig.length)
        || (Array.isArray(data.tapScriptSig) && data.tapScriptSig.length)
        || data.tapKeySig);
}

// Accept only p2pkh, p2wpkh or a p2sh whose supplied redeemScript is a p2wpkh hashing to it,
// the templates one key alone controls; p2wsh, multisig and p2tr can hide a second spender.
function singleKeyInput(psbt, i, script) {
    const redeem = psbt.data.inputs[i] && psbt.data.inputs[i].redeemScript;
    const templates = [
        () => bitcoin.payments.p2pkh({ output: script }),
        () => bitcoin.payments.p2wpkh({ output: script }),
        () => bitcoin.payments.p2sh({ output: script, redeem: bitcoin.payments.p2wpkh({ output: redeem }) }),
    ];
    return templates.some((build) => { try { build(); return true; } catch (e) { return false; } });
}

function isOpReturn(script) {
    try {
        const decompiled = bitcoin.script.decompile(script);
        return !!(decompiled && decompiled[0] === bitcoin.opcodes.OP_RETURN);
    } catch (e) { return false; }
}

// The script SHAPES a two-phase or envelope funding leg is allowed to take. These
// legs pay an encoder-derived script the SDK cannot predict (the P2SH/P2WSH data
// chunks, the one-shot envelope commit), and a chunked P2SH action emits as many of
// them as the payload needs, so they cannot be pinned by address or by count. What
// they can be pinned to is shape: a plain payment to an arbitrary P2PKH/P2WPKH
// recipient - the drain this gate exists to stop - is not one of these.
//
// Shape ALONE is not an authorization, though. A hostile encoder controls
// which p2sh/p2wsh/p2tr it emits, so shape by itself lets it park arbitrary value in
// a script only it can spend, and the maxFeeSats ceiling does not bound that: a
// parked output is counted in totalOut, so it lowers the computed fee rather than
// raising it. Every shaped output therefore also has to clear a value pin: the
// companion PSBT that spends it (`phaseSpends`), the later phase that spends it back
// (`requiredSpends`), or the caller's `maxPhaseFundingSats` ceiling.
const PHASE_SHAPES = {
    // OP_HASH160 <20> OP_EQUAL
    p2sh:  (d) => d.length === 3 && d[0] === bitcoin.opcodes.OP_HASH160 && Buffer.isBuffer(d[1]) && d[1].length === 20 && d[2] === bitcoin.opcodes.OP_EQUAL,
    // OP_0 <32>
    p2wsh: (d) => d.length === 2 && d[0] === bitcoin.opcodes.OP_0 && Buffer.isBuffer(d[1]) && d[1].length === 32,
    // OP_1 <32>
    p2tr:  (d) => d.length === 2 && d[0] === bitcoin.opcodes.OP_1 && Buffer.isBuffer(d[1]) && d[1].length === 32,
};

function matchesPhaseShape(script, shapes) {
    if (!shapes || !shapes.length) return false;
    let decompiled = null;
    try { decompiled = bitcoin.script.decompile(script); } catch (e) { return false; }
    if (!decompiled) return false;
    return shapes.some((name) => PHASE_SHAPES[name] && PHASE_SHAPES[name](decompiled));
}

// The prevouts a PSBT spends, as { script, value } in input order. This pins a funding
// leg to the companion transaction that consumes it: an envelope commit and
// its reveal arrive from ONE encoder answer, so the reveal's inputs are readable
// before the commit is signed. Returns null when any input carries no UTXO data,
// because a partial list would silently weaken the pin it feeds.
function psbtPrevouts(psbtHex) {
    let psbt;
    try { psbt = bitcoin.Psbt.fromHex(psbtHex); } catch (e) { return null; }
    const out = [];
    for (let i = 0; i < psbt.txInputs.length; i++) {
        const script = inputScript(psbt, i);
        const value = inputValue(psbt, i);
        if (!script || value === null) return null;
        out.push({ script, value });
    }
    return out;
}

// Consume one { script, value } match out of a prevout list, so N identical legs
// need N distinct spends rather than being satisfied by the same one N times.
function takeMatch(pool, script, value) {
    if (!pool) return false;
    const i = pool.findIndex((p) => !p.taken && p.script.equals(script) && p.value === value);
    if (i < 0) return false;
    pool[i].taken = true;
    return true;
}

// Resolve a submitted customOutput address to its script. An address the local
// network cannot parse authorizes nothing (it is not silently trusted): the output
// it was meant to authorize then falls through to UNRECONCILED_OUTPUT.
function scriptForAddress(address, network) {
    try { return bitcoin.address.toOutputScript(String(address), network || undefined); }
    catch (e) { return null; }
}

// Destinations that belong to the caller's own submitted identity. A phase whose
// only input is an encoder-derived leg (an envelope reveal, a chunk reveal) has no
// funding script to return change to, so rule (b) cannot authorize its change output
// and the caller's identity is the only pin left. Both default address types are
// admitted because a bare pubkey is address-type-ambiguous and both are the caller's
// own money either way; anything that is neither an address nor a pubkey yields
// nothing, so the output falls through to UNRECONCILED_OUTPUT.
// Admit only P2PKH on a supportsSegwit:false network, where a witness program is anyone-can-spend.
function callerScripts(identity, network) {
    if (typeof identity !== 'string' || !identity.length) return [];
    const direct = scriptForAddress(identity, network);
    if (direct) return [direct];
    if (!/^(0[23][0-9a-fA-F]{64}|04[0-9a-fA-F]{128})$/.test(identity)) return [];
    const pubkey = Buffer.from(identity, 'hex');
    const out = [];
    const builds = (network && network.supportsSegwit === false)
        ? [bitcoin.payments.p2pkh] : [bitcoin.payments.p2wpkh, bitcoin.payments.p2pkh];
    for (const build of builds) {
        try { out.push(build({ pubkey, network: network || undefined }).output); } catch (e) { /* not derivable here */ }
    }
    return out;
}

module.exports = {
    toU64,
    exactU64,
    inputScript,
    inputValue,
    inputPresigned,
    singleKeyInput,
    isOpReturn,
    PHASE_SHAPES,
    matchesPhaseShape,
    psbtPrevouts,
    takeMatch,
    scriptForAddress,
    callerScripts,
};
