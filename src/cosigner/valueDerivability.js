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
 * XChain Platform SDK - Co-Signer Value-Derivability Table (G2)
 *
 * An amount cap can only bind an action whose moved amount the evaluator can
 * actually READ off the action string. Before this table the guard was a
 * three-name denylist (SWEEP / AIRDROP / DIVIDEND); every other action with no
 * recognized amount field resolved its amount to `undefined`, and because
 * `maxPerAction`, `maxPerWindow.perTick` and `confirmAbove` are each guarded on
 * the amount being defined, all three silently SKIPPED. The operator got no
 * error and no enforcement - the co-signer's worst possible failure shape.
 *
 * This flips the guard from a denylist to an allowlist: every (action, version)
 * the co-signer's decoder can parse carries an explicit, deliberate entry here,
 * and anything absent DENIES with POLICY_UNBOUNDED_ACTION whenever the policy
 * expresses any amount-limiting intent. Adding a format to formats.js without
 * classifying it here fails the conformance test in
 * test/unit/cosignerValueDerivability.test.js, so the table cannot silently rot
 * behind a new action.
 *
 * --- the property being classified ---
 *
 * A format is value-derivable when the total TOKEN or NATIVE-COIN amount the
 * signing account gives up is determined by the action string alone (or is
 * zero). Two things are deliberately out of scope:
 *
 *   - GAS and protocol fees. They are charged in the gas token by consensus,
 *     are bounded on-chain (GAS_LIMIT / the protocol's own schedule), and no
 *     amount cap has ever bound them. Treating them as outflow would make
 *     every action underivable and the table useless.
 *   - The MINER fee, which the action string never constrains and which the
 *     daemon bounds separately and independently in `_checkFee` / maxFeeSats.
 *
 * "Moves no amount" (NONE) is a statement about VALUE, not about danger. An
 * ADDRESS v1 controller bind or a DELEGATE hands over authority and is NONE
 * here, because an amount cap is simply not the control that governs it -
 * `allowedActions` is. Do not read this table as a safety ranking.
 *
 ********************************************************************/

'use strict';

const Formats        = require('../formats.js');
const FormatSelector = require('../formatSelector.js');
const { ownLookup }  = require('./paramCharset.js');
// The decoder's bounded rest-field allowlist, so decodableFormats() measures the
// SAME surface the daemon actually reaches.
const { BOUNDED_REST_FORMATS } = require('./psbtActionDecode.js');

// The signing account can give up no token/native amount that the action
// string does not already state. Covers pure config/authority/data actions and
// actions that only ever credit the signer (a claim, a withdrawal of its own
// deposit, the return of its own stake).
const NONE = 'NONE';

// Both the amount AND the tick it is denominated in are determined by the
// action string (possibly via a protocol-fixed tick, e.g. capability STAKE is
// always gas-denominated). This is the only class an amount cap binds exactly.
const DERIVABLE = 'DERIVABLE';

// The only outflow is native coin, which the action string cannot constrain but
// the OUTPUT GATE and maxFeeSats do. Bounded, just not by an amount cap.
const NATIVE = 'NATIVE';

// Explicitly NOT derivable. Denies under any amount limit. Listed rather than
// omitted so the conformance test can tell "deliberately refused" from "nobody
// has classified this yet".
const UNBOUNDED = 'UNBOUNDED';

/*
 * VALUE-BY-REFERENCE (`byRef: true`)
 *
 * The action names an on-chain object by its ACTION_INDEX and the value moved
 * is a property of THAT object, which the daemon cannot read (it has no chain
 * access, by design - it decides from the PSBT alone). Cancelling an order or a
 * dispenser plausibly returns escrow rather than spending it, and resolving a
 * betting market pays out of protocol escrow rather than the signer's balance,
 * but the daemon cannot VERIFY any of that from the bytes in front of it, and a
 * future format revision could change it silently. Fail closed.
 *
 * Note this is narrower than "the format contains an *_ACTION_INDEX field".
 * DEPOSIT v0 and WITHDRAW v0 carry a CONTRACT_ACTION_INDEX that names the
 * contract, not the value: their TICK and QUANTITY are right there in the
 * string, so they classify DERIVABLE / NONE normally. The distinction is
 * whether the reference defines the VALUE.
 */

// action -> version -> entry
//   class      one of the four above
//   byRef      the referenced object defines the value (see above)
//   unless     field names that MUST be empty for `class` to hold; if any is
//              populated the format falls back to UNBOUNDED for that request.
//              This is how a format that is derivable in its common shape but
//              has an ownership/transfer escape hatch is handled precisely,
//              instead of allowlisting the hole or denying the whole format.
const TABLE = {
    ADDRESS: {
        0: { class: NONE },                                   // fee/memo/dispenser preferences
        1: { class: NONE },                                   // controller bind/unbind: authority, not amount
    },
    AIRDROP: {
        0: { class: UNBOUNDED, byRef: true },                 // AMOUNT x an off-chain LIST; per-unit amount under-counts the total
    },
    BATCH: {
        0: { class: UNBOUNDED },                              // a command bundle the single-leg evaluator cannot judge
    },
    BET: {
        0: { class: NONE },                                   // create a market: terms only, nothing escrowed at creation
        1: { class: UNBOUNDED, byRef: true },                 // cancel the referenced market
        2: { class: UNBOUNDED, byRef: true },                 // place a bet: AMOUNT is present but its TICK is the MARKET's, not the string's
        3: { class: UNBOUNDED, byRef: true },                 // resolve the referenced market
    },
    BROADCAST: {
        0: { class: NONE },                                   // VALUE is a feed datum, not an amount
        1: { class: NONE },
        2: { class: NONE },
        3: { class: NONE },                                   // updates a referenced feed; still moves nothing
    },
    CALLBACK: {
        0: { class: UNBOUNDED },                              // fires the token's CALLBACK_AMOUNT, fixed at ISSUE time and absent here
    },
    COINPAY: {
        0: { class: NATIVE, byRef: true },                    // pays a matched order in native coin: bounded by the output gate + maxFeeSats
    },
    COLLECT: {
        0: { class: NONE },                                   // claims accrued validator rewards TO the signer
    },
    DELEGATE: {
        0: { class: NONE },
        1: { class: NONE },
        2: { class: NONE },
        3: { class: NONE },
    },
    DEPLOY: {
        1: { class: NONE },                                   // gas is out of scope (see header); no token amount moves
        3: { class: NONE },
        4: { class: NONE },                                   // chunk carrier: pure data
    },
    DEPOSIT: {
        0: { class: DERIVABLE },                              // TICK + QUANTITY into the named contract
    },
    DESTROY: {
        0: { class: DERIVABLE },                              // TICK + AMOUNT of the signer's own supply
    },
    DISPENSER: {
        0: { class: DERIVABLE, unless: ['GIVE_OWNERSHIP'] },  // GIVE_TICK + GIVE_ESCROW; an ownership dispenser escrows a token ownership no amount describes
        1: { class: UNBOUNDED, byRef: true },                 // close the referenced dispenser
        2: { class: UNBOUNDED, byRef: true },                 // tops up GIVE_ESCROW, but in the REFERENCED dispenser's tick
    },
    DIVIDEND: {
        0: { class: UNBOUNDED },                              // AMOUNT per holder x an on-chain holder set the daemon cannot enumerate
    },
    EXECUTE: {
        // The contract's CODE decides what an EXECUTE moves, not the action
        // string: PARAMS are opaque method arguments and gas is metered by actual
        // VM consumption. So its value is by-reference in the strongest sense,
        // and refusing it under any amount limit is what makes the bounded rest
        // parse safe (see BOUNDED_REST_FORMATS in psbtActionDecode.js). Being
        // by-reference-only, an amount cap naming EXECUTE is also rejected at
        // construction, exactly like COINPAY.
        0: { class: UNBOUNDED, byRef: true },
    },
    FILE: {
        0: { class: NONE },
    },
    ISSUE: {
        0: { class: NONE, unless: ['TRANSFER', 'TRANSFER_SUPPLY'] },  // minting to self is a credit; TRANSFER hands away the token's OWNERSHIP and TRANSFER_SUPPLY hands away MINT_SUPPLY, neither expressible as a capped amount
        1: { class: NONE },                                   // description edit
        2: { class: NONE, unless: ['TRANSFER_SUPPLY'] },      // mint-param edit; same supply-transfer escape hatch
        3: { class: NONE },                                   // lock flags
        4: { class: NONE },                                   // callback params
        5: { class: NONE },                                   // allow/block lists
        6: { class: NONE },                                   // controller bind/unbind
    },
    LINK: {
        0: { class: NONE },
    },
    MESSAGE: {
        0: { class: NONE },
        1: { class: NONE },
        2: { class: NONE },
        3: { class: NONE },
    },
    MINT: {
        0: { class: DERIVABLE },                              // TICK + AMOUNT, possibly to a third-party DESTINATION
    },
    ORDER: {
        0: { class: DERIVABLE, unless: ['GIVE_OWNERSHIP'] },  // escrows GIVE_TICK/GIVE_AMOUNT; an ownership order escrows the token ownership instead
        1: { class: UNBOUNDED, byRef: true },                 // cancel the referenced order
        2: { class: UNBOUNDED, byRef: true },                 // edit the referenced order
    },
    PRICE: {
        1: { class: NONE },                                   // publishes a price datum; FEE is a percentage, not an amount
    },
    SEND: {
        0: { class: DERIVABLE },                              // the canonical single-leg transfer
    },
    SLEEP: {
        0: { class: NONE },
        1: { class: NONE },
    },
    STAKE: {
        1: { class: DERIVABLE },                              // capability stake: AMOUNT, gas-denominated by protocol (tickDefault)
        2: { class: DERIVABLE },
        3: { class: DERIVABLE },                              // contract stake: AMOUNT + explicit TICK
    },
    SWAP: {
        0: { class: DERIVABLE, unless: ['GIVE_OWNERSHIP'] },  // same shape as ORDER v0
        1: { class: UNBOUNDED, byRef: true },
        2: { class: UNBOUNDED, byRef: true },
    },
    SWEEP: {
        0: { class: UNBOUNDED },                              // transfers the ENTIRE balance; no amount field exists at all
    },
    UNSTAKE: {
        0: { class: NONE },                                   // begins cooldown returning the signer's OWN stake
        1: { class: NONE },
    },
    VOTE: {
        0: { class: DERIVABLE },                              // DEPOSIT + GAS_ESCROW, both gas-denominated (see policyEvaluator ACTION_VALUE_FIELDS)
        1: { class: NONE },                                   // cast a ballot: weight is measured from holdings, never moved
        2: { class: UNBOUNDED, byRef: true },                 // system-injected finalization of the referenced poll
        3: { class: NONE },                                   // set/clear a standing delegation
    },
    WITHDRAW: {
        0: { class: NONE },                                   // returns the signer's OWN contract deposit
    },
};

/*
 * Classify one decoded action.
 *
 * @param {string} action
 * @param {number} version
 * @param {object} [params]  decoded params, consulted only for `unless` fields
 * @returns {{class:string, byRef:boolean, blockedBy:(string|null)}}
 *   class 'UNBOUNDED' with blockedBy set means an otherwise-derivable format
 *   was demoted because an `unless` field is populated in THIS request.
 */
function classify(action, version, params) {
    const byAction = ownLookup(TABLE, action);
    const entry    = byAction ? ownLookup(byAction, String(version)) : undefined;
    // Absent = never classified. Fail closed, exactly as if it were UNBOUNDED:
    // an unknown format is precisely the case where nobody has established that
    // an amount cap can bind it.
    if (!entry) return { class: UNBOUNDED, byRef: false, blockedBy: null };
    if (entry.unless && params) {
        for (const field of entry.unless) {
            const v = ownLookup(params, field);
            if (v !== undefined && v !== null && v !== '')
                return { class: UNBOUNDED, byRef: !!entry.byRef, blockedBy: field };
        }
    }
    return { class: entry.class, byRef: !!entry.byRef, blockedBy: null };
}

// Can an amount cap ever bind this ACTION at all? A cap is keyed by action name
// only (`maxPerAction: {ACTION: {...}}`), so it is inert when EVERY format of
// that action is value-by-reference - the operator has written a limit that can
// never fire. CoSigner rejects such a policy at construction rather than
// leaving it silently decorative (G2). Computed from the table rather than
// hard-coded so a new by-reference-only action inherits the rejection.
function isCapInert(action) {
    const byAction = ownLookup(TABLE, action);
    if (!byAction) return false;                 // unknown action: allowedActions is the gate, not this
    const versions = Object.keys(byAction);
    if (versions.length === 0) return false;
    return versions.every((v) => byAction[v].byRef === true);
}

// Every (action, version) the co-signer's decoder can parse. Shares the
// decoder's structural gates so the conformance test measures the same
// surface the daemon actually reaches.
function decodableFormats() {
    const VALUE_FIELDS = new Set(['TICK', 'AMOUNT', 'DESTINATION']);
    const out = [];
    for (const action of Object.keys(Formats)) {
        for (const v of Object.keys(Formats[action])) {
            const version = Number(v);
            let fields;
            try { fields = FormatSelector.getFormatFields(action, version); } catch (e) { continue; }
            if (!Array.isArray(fields) || fields[0] !== 'VERSION') continue;
            const bounded = BOUNDED_REST_FORMATS.get(`${action} ${version}`) || null;
            let refused = false;
            const seen = new Set();
            for (const f of fields) {
                // Mirror the decoder: a rest field is refused unless this exact
                // (action, version) is on its bounded allowlist.
                if (FormatSelector.isRestField(f)) {
                    if (!bounded || bounded.restField !== f) { refused = true; break; }
                    continue;
                }
                if (VALUE_FIELDS.has(f)) {
                    if (seen.has(f)) { refused = true; break; }
                    seen.add(f);
                }
            }
            if (refused) continue;
            let repeated = null;
            try { repeated = FormatSelector.getRepeatedGroup(action, version); } catch (e) { continue; }
            if (repeated) continue;
            out.push({ action, version, fields: fields.slice(1) });
        }
    }
    return out;
}

module.exports = {
    classify,
    isCapInert,
    decodableFormats,
    TABLE,
    NONE,
    DERIVABLE,
    NATIVE,
    UNBOUNDED,
};
