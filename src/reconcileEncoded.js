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

/*
 * Reconcile an encoder-authored PSBT against the intent that was submitted, at the
 * last moment before a signature exists.
 *
 * The encoder is a REMOTE service (encoder.createTx / spendP2sh are RPC calls). It
 * chooses the inputs, the outputs and the miner fee, and until this gate existed
 * nothing between that response and wallet.signPsbt asked whether what came back
 * still matched what was asked for. A compromised or misconfigured encoder could
 * therefore point wallet-owned value at an output of its choosing, or burn the whole
 * balance as fee, behind an action string that reads as benign.
 *
 * The daemon co-signer already reconciles its own side (coSigner.js _checkOutputs /
 * _checkFee); this is the same discipline for the single-WIF path, which has no
 * daemon in it. Rules are chosen to be false-positive-free: every authorization is
 * read out of the PSBT itself or out of the caller's own submitted intent, never
 * guessed from the encoder's answer.
 *
 * Fail-closed: throws SDKActionError on the first output or fee it cannot account
 * for. Returns { fee, totalIn, totalOut } (fee null when the PSBT does not carry
 * enough input data to compute one).
 */

const bitcoin = require('bitcoinjs-lib');
const { SDKActionError } = require('./errors.js');

// Satoshi values arrive as Number OR BigInt: applyBufferutilsPatch teaches
// bip174/bitcoinjs to carry values above 2^53-1 (large DOGE UTXOs) as BigInt.
// All arithmetic here is BigInt so a >2^53 value is neither rejected nor rounded.
function toU64(v) {
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return BigInt(v);
    return null;
}

// Same, plus the decimal-STRING form (#3922). A caller-supplied cap in
// intent.customOutputs may legitimately arrive as a string (that is what the
// encoder's parseSatoshiAmount allowBig path exists for), and the Number() hop that
// used to precede toU64 rounded it away above 2^53. Mirrors cosigner exactU64.
function exactU64(v) {
    if (typeof v === 'bigint') return v >= 0n ? v : null;
    if (typeof v === 'number') return (Number.isInteger(v) && v >= 0) ? BigInt(v) : null;
    if (typeof v === 'string' && /^\d+$/.test(v.trim())) return BigInt(v.trim());
    return null;
}

// The output script an input spends, from whichever UTXO form the PSBT carries.
// bitcoinjs needs one of the two to sign at all, so an input with neither cannot
// be signed and the fail-closed path below is not a false positive.
function inputScript(psbt, i) {
    const data = psbt.data.inputs[i];
    if (!data) return null;
    if (data.witnessUtxo && data.witnessUtxo.script) return data.witnessUtxo.script;
    if (data.nonWitnessUtxo) {
        try {
            const prev = bitcoin.Transaction.fromBuffer(data.nonWitnessUtxo);
            const vout = psbt.txInputs[i].index;
            const out = prev.outs[vout];
            return out ? out.script : null;
        } catch (e) { return null; }
    }
    return null;
}

// The value an input brings in, same two forms.
function inputValue(psbt, i) {
    const data = psbt.data.inputs[i];
    if (!data) return null;
    if (data.witnessUtxo) return toU64(data.witnessUtxo.value);
    if (data.nonWitnessUtxo) {
        try {
            const prev = bitcoin.Transaction.fromBuffer(data.nonWitnessUtxo);
            const out = prev.outs[psbt.txInputs[i].index];
            return out ? toU64(out.value) : null;
        } catch (e) { return null; }
    }
    return null;
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
// Shape ALONE is not an authorization, though . A hostile encoder controls
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

// The prevouts a PSBT spends, as { script, value } in input order. Used to pin a
// funding leg to the companion transaction that consumes it: an envelope commit and
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
function callerScripts(identity, network) {
    if (typeof identity !== 'string' || !identity.length) return [];
    const direct = scriptForAddress(identity, network);
    if (direct) return [direct];
    if (!/^(0[23][0-9a-fA-F]{64}|04[0-9a-fA-F]{128})$/.test(identity)) return [];
    const pubkey = Buffer.from(identity, 'hex');
    const out = [];
    for (const build of [bitcoin.payments.p2wpkh, bitcoin.payments.p2pkh]) {
        try { out.push(build({ pubkey, network: network || undefined }).output); } catch (e) { /* not derivable here */ }
    }
    return out;
}

/*
 * @param {string} psbtHex          the encoder's answer, unsigned
 * @param {object} intent
 *   network        {object}   bitcoinjs network, for parsing submitted addresses
 *   customOutputs  {Array}    [{ address, value }] exactly as submitted, or null
 *   changeAddresses {Array}   change destinations the caller itself submitted. Same
 *                             standing as change back to an input script, and it has
 *                             to be stated: a submitted P2SH change address is
 *                             shape-identical to a chunk leg, so without this it
 *                             would be mistaken for one
 *   callerIdentities {Array}  the caller's own `pubkey` identity (address or raw
 *                             pubkey hex), whose default-type scripts a reveal with
 *                             no wallet input of its own returns change to
 *   maxFeeSats     {number}   absolute fee ceiling from the caller, or null
 *   phaseShapes    {string[]} script shapes this phase's encoder-derived funding
 *                             legs may take ('p2sh' / 'p2wsh' / 'p2tr'), empty or
 *                             absent for a plain single-phase action
 *   phaseSpends    {Array}    prevouts of the companion PSBT that consumes this
 *                             phase's funding legs (psbtPrevouts of the envelope
 *                             reveal). When set, a shaped output is authorized only
 *                             if that companion provably spends it
 *   requiredSpends {Array}    funding legs an EARLIER phase paid out that this PSBT
 *                             must consume as inputs, so value the SDK authorized by
 *                             shape is proven to come back rather than stay parked
 *   maxPhaseFundingSats       absolute ceiling on the TOTAL value across this PSBT's
 *                  {number}   shaped funding legs, or null. maxFeeSats does not
 *                             bound them, so this is the caller's only value cap on
 *                             a phase-1 leg no companion PSBT can pin yet
 *   label          {string}   which PSBT this is, for the error message
 *
 * Returns { fee, totalIn, totalOut, phaseFunding }, where phaseFunding is the list of
 * shaped legs this PSBT paid, ready to hand to the next phase as requiredSpends.
 */
function reconcileEncoded(psbtHex, intent) {
    intent = intent || {};
    const label = intent.label || 'transaction';
    const deny = (code, detail) => {
        throw new SDKActionError(code,
            'encoder-authored ' + label + ' does not reconcile against the submitted intent: '
            + (typeof detail === 'string' ? detail : JSON.stringify(detail)),
            { psbtHex, detail });
    };

    let psbt;
    try { psbt = bitcoin.Psbt.fromHex(psbtHex); }
    catch (e) { return deny('UNRECONCILABLE_PSBT', 'the encoder response is not a decodable PSBT: ' + (e && e.message)); }

    // Funding scripts: change returning to a script we are already spending FROM
    // stays under the signer's control, whichever address scheme the encoder chose.
    // Reading them out of the PSBT is what makes this rule false-positive-free -
    // the SDK cannot predict the change script otherwise, since `pubkey` may be a
    // raw key and the encoder picks the scheme.
    const fundingScripts = [];
    const spent = [];
    let totalIn = 0n;
    let feeComputable = true;
    for (let i = 0; i < psbt.txInputs.length; i++) {
        const script = inputScript(psbt, i);
        if (!script) return deny('UNRECONCILABLE_PSBT', 'input ' + i + ' carries no witnessUtxo or nonWitnessUtxo, so its funding script cannot be established');
        fundingScripts.push(script);
        const value = inputValue(psbt, i);
        if (value === null) feeComputable = false; else totalIn += value;
        spent.push({ script, value });
    }
    if (!fundingScripts.length) return deny('UNRECONCILABLE_PSBT', 'the encoder returned a transaction with no inputs');

    // Recovery pin . An earlier phase paid funding legs this gate could only
    // authorize by shape; this phase is the transaction that is supposed to spend them
    // back. A leg missing from these inputs is value the encoder kept, so refuse here
    // rather than sign a reveal that abandons it. False-positive-free: every chunk
    // output has to be revealed for the payload to decode at all, so a legitimate
    // reveal always consumes the full set.
    for (const leg of (Array.isArray(intent.requiredSpends) ? intent.requiredSpends : [])) {
        if (!takeMatch(spent, leg.script, leg.value))
            return deny('PHASE_FUNDING_UNSPENT',
                { script: leg.script.toString('hex'), value: String(leg.value),
                  detail: 'an earlier phase funded this shaped output and this transaction does not spend it back' });
    }

    // Submitted customOutputs, summed per address: N outputs to the same authorized
    // address are capped on their total, or a repeated output multiplies the cap.
    const authorized = [];
    for (const out of (Array.isArray(intent.customOutputs) ? intent.customOutputs : [])) {
        if (!out || out.address == null) continue;
        const script = scriptForAddress(out.address, intent.network);
        if (!script) continue;
        const value = exactU64(out.value);
        const existing = authorized.find((a) => a.script.equals(script));
        if (existing) existing.maxValue += (value === null ? 0n : value);
        else authorized.push({ script, maxValue: (value === null ? 0n : value), spent: 0n });
    }

    const changeScripts = [];
    for (const addr of (Array.isArray(intent.changeAddresses) ? intent.changeAddresses : [intent.changeAddresses])) {
        if (addr == null) continue;
        const script = scriptForAddress(addr, intent.network);
        if (script) changeScripts.push(script);
    }
    for (const id of (Array.isArray(intent.callerIdentities) ? intent.callerIdentities : [intent.callerIdentities])) {
        for (const script of callerScripts(id, intent.network)) changeScripts.push(script);
    }

    let totalOut = 0n;
    const phaseShapes = Array.isArray(intent.phaseShapes) ? intent.phaseShapes : [];
    // Companion pin: the prevouts of the PSBT that consumes this phase's legs, if one
    // exists yet. `null` (absent) and `[]` (a companion with no readable prevouts) are
    // different answers, and the second one must authorize nothing.
    const phaseSpends = Array.isArray(intent.phaseSpends)
        ? intent.phaseSpends.map((p) => ({ script: p.script, value: p.value }))
        : null;
    const phaseFunding = [];
    let phaseFundingTotal = 0n;
    for (let i = 0; i < psbt.txOutputs.length; i++) {
        const out = psbt.txOutputs[i];
        const value = toU64(out.value);
        if (value === null) return deny('UNRECONCILABLE_PSBT', 'output ' + i + ' has a non-integer value');
        totalOut += value;

        // (a) The OP_RETURN data carrier holds the action, not value. It is provably
        //     unspendable, so any satoshis on it are burned - a drain by destruction
        //     rather than diversion, which the value guard closes.
        if (isOpReturn(out.script)) {
            if (value > 0n) return deny('OP_RETURN_CARRIES_VALUE', { index: i, value: String(value) });
            continue;
        }
        // (b) Change back to a script we are spending from, or to the change address
        //     the caller submitted. Both stay under the caller's control, and the
        //     second has to be checked BEFORE the shape rule: a submitted P2SH change
        //     address decompiles identically to a chunk funding leg, so classifying it
        //     as one would demand the next phase spend it back.
        if (fundingScripts.some((s) => out.script.equals(s))) continue;
        if (changeScripts.some((s) => out.script.equals(s))) continue;
        // (c) An output the caller itself asked for, capped at what it asked for.
        const match = authorized.find((a) => a.script.equals(out.script));
        if (match) {
            match.spent += value;
            if (match.spent > match.maxValue)
                return deny('OUTPUT_OVER_REQUESTED_VALUE',
                    { index: i, value: String(value), total: String(match.spent), requested: String(match.maxValue) });
            continue;
        }
        // (d) An encoder-derived funding leg for this phase. Shape gets it this far
        //     only: the script is the encoder's to derive and a chunked payload emits
        //     as many of them as it needs, so neither address nor count can pin it.
        //     Value is pinned separately, by whichever of the two mechanisms this
        //     phase has , and a leg that clears neither is a park.
        if (matchesPhaseShape(out.script, phaseShapes)) {
            // Where a companion PSBT already exists (the envelope pair comes back
            // from one createTx call), the leg must be exactly what that companion
            // spends. Value parked in a shaped script the reveal never touches fails
            // here, before the commit is signed.
            if (phaseSpends && !takeMatch(phaseSpends, out.script, value))
                return deny('PHASE_FUNDING_UNSPENT',
                    { index: i, value: String(value), script: out.script.toString('hex'),
                      detail: 'the companion transaction for this phase does not spend this funding leg' });
            phaseFunding.push({ script: out.script, value });
            phaseFundingTotal += value;
            continue;
        }
        // Anything else is value leaving for a destination nobody asked for.
        return deny('UNRECONCILED_OUTPUT', { index: i, value: String(value), script: out.script.toString('hex') });
    }

    // Phase-1 of a chunked action has no companion PSBT yet (spendP2sh is only
    // callable once phase 1 is on chain), so the recovery pin above is detection after
    // the fact. This opt-in ceiling is the caller's prevention for that window. It is
    // separate from maxFeeSats because a parked output is not fee: the legs prefund
    // the next phase and are dust-scale, so a cap here is a small number.
    const maxPhaseFunding = exactU64(intent.maxPhaseFundingSats);
    if (intent.maxPhaseFundingSats != null && maxPhaseFunding !== null && phaseFundingTotal > maxPhaseFunding)
        return deny('PHASE_FUNDING_OVER_CAP',
            { total: String(phaseFundingTotal), legs: phaseFunding.length, maxPhaseFundingSats: String(maxPhaseFunding) });

    if (!feeComputable) return { fee: null, totalIn: null, totalOut, phaseFunding };

    // (e) Fee. The action string never constrains the miner fee, so an encoder can
    //     drain the balance by omitting or undersizing change and leaving the
    //     remainder to miners. Two always-on guards that cannot false-positive: a
    //     value-negative (unrelayable) transaction, and the canonical full burn
    //     where nothing comes back at all. A tighter bound needs the caller's cap,
    //     because an undersized change output is indistinguishable from a
    //     legitimately high fee without chain knowledge.
    if (totalOut > totalIn)
        return deny('NEGATIVE_FEE', { totalIn: String(totalIn), totalOut: String(totalOut) });
    if (totalIn > 0n && totalOut === 0n)
        return deny('FULL_BURN_FEE', { totalIn: String(totalIn), detail: 'every satoshi would go to miners' });
    const fee = totalIn - totalOut;
    // Caller-supplied cap, parsed exactly (#3869 residual, ): the Number() hop
    // that used to precede toU64 rounded a >2^53 cap, which both slackens and
    // false-positives the comparison. exactU64 also keeps the decimal-STRING form the
    // encoder's allowBig path emits.
    const maxFee = exactU64(intent.maxFeeSats);
    if (intent.maxFeeSats != null && maxFee !== null && fee > maxFee)
        return deny('FEE_OVER_CAP', { fee: String(fee), maxFeeSats: String(maxFee) });

    return { fee, totalIn, totalOut, phaseFunding };
}

module.exports = { reconcileEncoded, psbtPrevouts };
