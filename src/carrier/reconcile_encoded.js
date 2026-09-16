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
 * The daemon co-signer already reconciles its own side (co_signer.js _checkOutputs /
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
const { SDKActionError } = require('../utils/errors.js');
const {
    toU64,
    exactU64,
    inputScript,
    inputValue,
    inputPresigned,
    isOpReturn,
    matchesPhaseShape,
    psbtPrevouts,
    takeMatch,
    scriptForAddress,
    callerScripts,
} = require('./reconcile_encoded/script_matching.js');

// Bind refusal details once so every check throws the same SDK error shape.
function createDeny(psbtHex, label) {
    return (code, detail) => {
        throw new SDKActionError(code,
            'encoder-authored ' + label + ' does not reconcile against the submitted intent: '
            + (typeof detail === 'string' ? detail : JSON.stringify(detail)),
            { psbtHex, detail });
    };
}

// Read signer-owned funding state once so output authorization uses proven scripts.
function readInputs(psbt, deny) {
    // Funding scripts: change returning to an UNSIGNED script we are already spending
    // FROM stays under the signer's control, whichever address scheme the encoder chose.
    // Reading them out of the PSBT is what makes this rule false-positive-free -
    // the SDK cannot predict the change script otherwise, since `pubkey` may be a
    // raw key and the encoder picks the scheme. The unsigned qualifier is load-bearing;
    // see the per-input note below.
    const fundingScripts = [];
    const spent = [];
    let totalIn = 0n;
    let feeComputable = true;
    for (let i = 0; i < psbt.txInputs.length; i++) {
        const script = inputScript(psbt, i);
        if (!script) return deny('UNRECONCILABLE_PSBT', 'input ' + i + ' carries no witnessUtxo or nonWitnessUtxo, so its funding script cannot be established');
        // Rule (b) below reads "spending FROM it" as proof the destination stays under
        // the signer's control, and that only holds for inputs the WIF owns. A hostile
        // encoder can attach its OWN pre-signed input and point the wallet-funded
        // remainder at that input's script, which rule (b) would then wave through as
        // change while signAllInputs/finalizeAllInputs completes the drain. A pre-signed
        // input is provably not ours here, so it funds and it is spent, but it never
        // authorizes a change destination.
        if (!inputPresigned(psbt, i)) fundingScripts.push(script);
        const value = inputValue(psbt, i);
        if (value === null) feeComputable = false; else totalIn += value;
        spent.push({ script, value });
    }
    // Counted on the PSBT, not on fundingScripts: an all-pre-signed transaction has
    // inputs but no signer-owned one, and it is denied below with its own reason
    // rather than mislabelled as input-less.
    if (!psbt.txInputs.length) return deny('UNRECONCILABLE_PSBT', 'the encoder returned a transaction with no inputs');
    if (!fundingScripts.length) return deny('NO_SIGNER_OWNED_INPUT',
        'every input in the encoder response already carries a signature, so none of them is the local signer\'s');

    return { fundingScripts, spent, totalIn, feeComputable };
}

// Consume every required leg so later phases cannot leave authorized value parked.
function checkRequiredSpends(intent, spent, deny) {
    // Recovery pin. An earlier phase paid funding legs this gate could only
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
}

// Aggregate submitted destinations so repeated outputs share one exact cap.
function readAuthorizedOutputs(intent) {
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
    return authorized;
}

// Resolve explicit change destinations so only caller-controlled scripts are admitted.
function readChangeScripts(intent) {
    const changeScripts = [];
    for (const addr of (Array.isArray(intent.changeAddresses) ? intent.changeAddresses : [intent.changeAddresses])) {
        if (addr == null) continue;
        const script = scriptForAddress(addr, intent.network);
        if (script) changeScripts.push(script);
    }
    for (const id of (Array.isArray(intent.callerIdentities) ? intent.callerIdentities : [intent.callerIdentities])) {
        for (const script of callerScripts(id, intent.network)) changeScripts.push(script);
    }
    return changeScripts;
}

// Grade one output at a time so transaction accounting preserves first-error order.
function reconcileOutput(out, i, inputs, outputs, deny) {
    const value = toU64(out.value);
    if (value === null) return deny('UNRECONCILABLE_PSBT', 'output ' + i + ' has a non-integer value');
    outputs.totalOut += value;

    // (a) The OP_RETURN data carrier holds the action, not value. It is provably
    //     unspendable, so any satoshis on it are burned - a drain by destruction
    //     rather than diversion, which the value guard closes.
    if (isOpReturn(out.script)) {
        if (value > 0n) return deny('OP_RETURN_CARRIES_VALUE', { index: i, value: String(value) });
        return;
    }
    // (b) Change back to an UNSIGNED script we are spending from (see the input
    //     loop: a pre-signed input is foreign and never reaches fundingScripts),
    //     or to the change address the caller submitted. Both stay under the
    //     caller's control, and the
    //     second has to be checked BEFORE the shape rule: a submitted P2SH change
    //     address decompiles identically to a chunk funding leg, so classifying it
    //     as one would demand the next phase spend it back.
    if (inputs.fundingScripts.some((s) => out.script.equals(s))) return;
    if (inputs.changeScripts.some((s) => out.script.equals(s))) return;
    // (c) An output the caller itself asked for, capped at what it asked for.
    const match = inputs.authorized.find((a) => a.script.equals(out.script));
    if (match) {
        match.spent += value;
        if (match.spent > match.maxValue)
            return deny('OUTPUT_OVER_REQUESTED_VALUE',
                { index: i, value: String(value), total: String(match.spent), requested: String(match.maxValue) });
        return;
    }
    // (d) An encoder-derived funding leg for this phase. Shape gets it this far
    //     only: the script is the encoder's to derive and a chunked payload emits
    //     as many of them as it needs, so neither address nor count can pin it.
    //     Value is pinned separately, by whichever of the two mechanisms this
    //     phase has, and a leg that clears neither is a park.
    if (matchesPhaseShape(out.script, outputs.phaseShapes)) {
        // Where a companion PSBT already exists (the envelope pair comes back
        // from one createTx call), the leg must be exactly what that companion
        // spends. Value parked in a shaped script the reveal never touches fails
        // here, before the commit is signed.
        if (outputs.phaseSpends && !takeMatch(outputs.phaseSpends, out.script, value))
            return deny('PHASE_FUNDING_UNSPENT',
                { index: i, value: String(value), script: out.script.toString('hex'),
                  detail: 'the companion transaction for this phase does not spend this funding leg' });
        outputs.phaseFunding.push({ script: out.script, value });
        outputs.phaseFundingTotal += value;
        return;
    }
    // Anything else is value leaving for a destination nobody asked for.
    return deny('UNRECONCILED_OUTPUT', { index: i, value: String(value), script: out.script.toString('hex') });
}

// Scan outputs in transaction order so accounting and refusal order remain stable.
function reconcileOutputs(psbt, intent, inputs, deny) {
    const outputs = {
        totalOut: 0n,
        phaseShapes: Array.isArray(intent.phaseShapes) ? intent.phaseShapes : [],
        // Companion pin: the prevouts of the PSBT that consumes this phase's legs, if one
        // exists yet. `null` (absent) and `[]` (a companion with no readable prevouts) are
        // different answers, and the second one must authorize nothing.
        phaseSpends: Array.isArray(intent.phaseSpends)
            ? intent.phaseSpends.map((p) => ({ script: p.script, value: p.value }))
            : null,
        phaseFunding: [],
        phaseFundingTotal: 0n,
    };
    for (let i = 0; i < psbt.txOutputs.length; i++) {
        reconcileOutput(psbt.txOutputs[i], i, inputs, outputs, deny);
    }
    return outputs;
}

// Enforce the funding ceiling after all shaped legs have been totaled.
function checkPhaseFundingCap(intent, outputs, deny) {
    // Phase-1 of a chunked action has no companion PSBT yet (spendP2sh is only
    // callable once phase 1 is on chain), so the recovery pin above is detection after
    // the fact. This opt-in ceiling is the caller's prevention for that window. It is
    // separate from maxFeeSats because a parked output is not fee: the legs prefund
    // the next phase and are dust-scale, so a cap here is a small number.
    const maxPhaseFunding = exactU64(intent.maxPhaseFundingSats);
    // A cap that will not parse is a cap that cannot be enforced, and skipping the
    // comparison would silently remove the bound the caller believes it set - worse
    // than passing no cap at all, because the caller thinks it is protected. Fail
    // closed here, like every sibling exactU64 caller (co_signer.js, recovery.js).
    if (intent.maxPhaseFundingSats != null && maxPhaseFunding === null)
        return deny('MALFORMED_PHASE_FUNDING_CAP',
            { maxPhaseFundingSats: String(intent.maxPhaseFundingSats),
              detail: 'maxPhaseFundingSats must be a non-negative integer (number, bigint, or digit string); the cap cannot be enforced as given' });
    if (intent.maxPhaseFundingSats != null && outputs.phaseFundingTotal > maxPhaseFunding)
        return deny('PHASE_FUNDING_OVER_CAP',
            { total: String(outputs.phaseFundingTotal), legs: outputs.phaseFunding.length, maxPhaseFundingSats: String(maxPhaseFunding) });
}

// Finish fee accounting only when every input value is available.
function reconcileFee(intent, inputs, outputs, deny) {
    if (!inputs.feeComputable)
        return { fee: null, totalIn: null, totalOut: outputs.totalOut, phaseFunding: outputs.phaseFunding };
    // (e) Fee. The action string never constrains the miner fee, so an encoder can
    //     drain the balance by omitting or undersizing change and leaving the
    //     remainder to miners. Two always-on guards that cannot false-positive: a
    //     value-negative (unrelayable) transaction, and the canonical full burn
    //     where nothing comes back at all. A tighter bound needs the caller's cap,
    //     because an undersized change output is indistinguishable from a
    //     legitimately high fee without chain knowledge.
    if (outputs.totalOut > inputs.totalIn)
        return deny('NEGATIVE_FEE', { totalIn: String(inputs.totalIn), totalOut: String(outputs.totalOut) });
    if (inputs.totalIn > 0n && outputs.totalOut === 0n)
        return deny('FULL_BURN_FEE', { totalIn: String(inputs.totalIn), detail: 'every satoshi would go to miners' });
    const fee = inputs.totalIn - outputs.totalOut;
    // Caller-supplied cap is parsed exactly. Routing it through Number before
    // toU64 rounds a >2^53 cap, which both slackens and false-positives the
    // comparison. exactU64 also keeps the decimal-STRING form the encoder emits.
    const maxFee = exactU64(intent.maxFeeSats);
    // Same fail-closed rule as the phase-funding cap above: an unparseable ceiling
    // is denied, never treated as no ceiling.
    if (intent.maxFeeSats != null && maxFee === null)
        return deny('MALFORMED_FEE_CAP',
            { maxFeeSats: String(intent.maxFeeSats),
              detail: 'maxFeeSats must be a non-negative integer (number, bigint, or digit string); the cap cannot be enforced as given' });
    if (intent.maxFeeSats != null && fee > maxFee)
        return deny('FEE_OVER_CAP', { fee: String(fee), maxFeeSats: String(maxFee) });

    return { fee, totalIn: inputs.totalIn, totalOut: outputs.totalOut, phaseFunding: outputs.phaseFunding };
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
    const deny = createDeny(psbtHex, label);

    let psbt;
    try { psbt = bitcoin.Psbt.fromHex(psbtHex); }
    catch (e) { return deny('UNRECONCILABLE_PSBT', 'the encoder response is not a decodable PSBT: ' + (e && e.message)); }

    const inputs = readInputs(psbt, deny);
    checkRequiredSpends(intent, inputs.spent, deny);
    inputs.authorized = readAuthorizedOutputs(intent);
    inputs.changeScripts = readChangeScripts(intent);
    const outputs = reconcileOutputs(psbt, intent, inputs, deny);
    checkPhaseFundingCap(intent, outputs, deny);
    return reconcileFee(intent, inputs, outputs, deny);
}

module.exports = { reconcileEncoded, psbtPrevouts };
