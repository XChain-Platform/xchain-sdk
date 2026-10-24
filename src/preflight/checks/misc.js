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
 * Pre-flight Tier-2: actions without a dedicated check module yet
 * (STAKE/UNSTAKE/DELEGATE/VOTE/COLLECT, DEPLOY/EXECUTE/DEPOSIT/
 * WITHDRAW, COINPAY, BROADCAST/MESSAGE/FILE/LINK/LIST/ADDRESS/PRICE/
 * SLEEP/CALLBACK/SWEEP). The universal checks (parse/validator,
 * token existence, encoding, fee notices) already ran; the per-action
 * state aspects surface as `unverified` - degraded but honest, and
 * incapable of a false hard-block by construction. Tier 1 covers the
 * quotable subset authoritatively. Dedicated modules land as their
 * matrix rows harden (§4.4 remains the roadmap). Two STAKE rules are judged
 * here rather than declared: the AMOUNT width every format's row column holds,
 * and a capability STAKE's gas-token balance, which the explorer serves; the
 * handler refuses on each without any activation.
 *
 ********************************************************************/

'use strict';

const { FINDING_CODES } = require('../constants.js');
const numeric = require('../numeric.js');
const { GAS_TICK } = require('../../protocol/constants.js');

// stakes.amount and contract_stakes.amount are VARCHAR(250). Every STAKE format refuses an
// AMOUNT wider than that as 'invalid: AMOUNT (format)' through storesAsNull, ahead of its
// shape check and with no activation (xchain-indexer src/actions/stake/capability_stake.js
// validateCapabilityWire, contract_stake.js validateStakeAmount); a node without that
// refusal stops at the row write on a strict server. Counted in characters, as the indexer
// counts it, so a leading-zero padded amount is refused even though its value is small.
const STAKE_AMOUNT_MAX_CHARS = 250;

// Returns true when it raised, so the balance check does not judge an amount already refused.
function checkStakeAmountWidth(ctx) {
    ctx.markRun(FINDING_CODES.AMOUNT_FORMAT_INVALID);
    const amount = ctx.field('AMOUNT');
    if (amount === '' || Array.isArray(amount)) return false;
    const width = Array.from(amount).length;
    if (width <= STAKE_AMOUNT_MAX_CHARS) return false;
    ctx.addFinding(FINDING_CODES.AMOUNT_FORMAT_INVALID, 'error',
        `AMOUNT is ${width} characters, wider than the ${STAKE_AMOUNT_MAX_CHARS}-character stake amount `
        + 'column; the indexer rejects this STAKE as invalid: AMOUNT (format).',
        { field: 'AMOUNT', width, limit: STAKE_AMOUNT_MAX_CHARS });
    return true;
}

// A capability STAKE (formats 1 and 2) escrows AMOUNT of the gas token, and the indexer
// refuses one the source's balance does not cover, once the gas token exists
// (xchain-indexer src/actions/stake/capability_stake.js:69-75, 'insufficient funds (STAKE)').
// Format 3 stakes another token through contract_stake.js and is not judged here.
async function checkCapabilityStakeBalance(ctx) {
    const version = String(ctx.parsed.version);
    if (version !== '1' && version !== '2') return;
    const amount = ctx.field('AMOUNT');
    if (amount === '' || Array.isArray(amount)) return;
    let positive;
    try { positive = numeric.isPositive(amount); } catch (e) { return; }
    if (!positive) return;
    if (!ctx.source) {
        ctx.addUnverified(FINDING_CODES.BALANCE_INSUFFICIENT, 'no source address supplied');
        return;
    }
    const token = await ctx.token(GAS_TICK);
    if (token === undefined) {
        ctx.addUnverified(FINDING_CODES.BALANCE_INSUFFICIENT, 'token lookup unavailable for ' + GAS_TICK);
        return;
    }
    if (token === null) return;
    const balance = await ctx.balance(ctx.source, GAS_TICK);
    if (balance === null) {
        ctx.addUnverified(FINDING_CODES.BALANCE_INSUFFICIENT, 'balance lookup unavailable for ' + GAS_TICK);
        return;
    }
    ctx.markRun(FINDING_CODES.BALANCE_INSUFFICIENT);
    if (numeric.gte(balance, amount)) return;
    const inFlight = ctx.deltaApplied(GAS_TICK);
    const netted = numeric.isPositive(inFlight);
    ctx.addFinding(FINDING_CODES.BALANCE_INSUFFICIENT, 'error',
        `Balance of ${GAS_TICK} (${balance}${netted ? ` after ${inFlight} already committed from this wallet` : ''}) `
        + `does not cover the stake (${amount}); the indexer rejects it as insufficient funds (STAKE).`,
        { tick: GAS_TICK, balance, amount, ...(netted ? { localDeltaApplied: inFlight } : {}) });
}

// Per-action note: which aspect the server alone can judge (keeps the
// unverified entries specific rather than a generic shrug).
const ASPECT_NOTES = {
    SWEEP:    'fee affordability resolves via the server dry-run only; an empty sweep is a valid no-op',
    STAKE:    'stakeable-target and guard outcomes resolve server-side',
    UNSTAKE:  'active-stake ownership and cooldown state resolve server-side',
    DELEGATE: 'active-stake presence and key-collision scoping resolve server-side',
    VOTE:     'poll state, ballot validity, and vote weight resolve server-side; re-voting is legal (overwrite)',
    COLLECT:  'unclaimed reward balance and pool solvency resolve server-side',
    DEPLOY:   'chunk-set completeness, VM syntax, and constructor gas resolve server-side (Tier-1 denylisted)',
    EXECUTE:  'contract state and gas resolve server-side; a bad METHOD reverts at runtime WITH the fee charged',
    DEPOSIT:  'contract active-state resolves server-side; from the CONTROLLER_CUSTODY_GUARD flag day, the token\'s transfer or all controller and SOURCE\'s own address controller (the depositor) gate the move; both guards and their gas resolve server-side',
    WITHDRAW: 'deployer-only gate and contract credit resolve server-side; from the CONTROLLER_CUSTODY_GUARD flag day, the token\'s transfer or all controller and SOURCE\'s own address controller (the withdrawer) gate the move; both guards and their gas resolve server-side',
    COINPAY:  'obligation existence/match/expiry resolve server-side; Tier 1 gives NO verdict (feeExempt)',
    // null: the action has no chain-state precondition at all, so there is
    // nothing the client failed to check and nothing belongs under the
    // wallet's "Could not verify" heading. Emitting "no chain-state
    // preconditions beyond format" there read as a failure to the first
    // testnet user who met it, and a positive statement filed under a
    // negative heading is worse than no entry.
    BROADCAST: null,
    MESSAGE:   null,
    FILE:     'gated-transfer ownership/escrow state resolves server-side',
    LINK:     'target-action ownership resolves server-side',
    LIST:     'per-item validity is recorded per-item on-chain; server-side refuses a whole SHARE or TRANSFER from anyone but the list\'s current owner, a SHARE of a union or already-shared list, a SHARE of a list over 10,000 members, and a shared-list edit past 10,000 members',
    ADDRESS:  'contract bindability and live-bind state resolve server-side',
    PRICE:    'oracle authority (capability stake) resolves server-side',
    SLEEP:    'ownership, lock, and escrow state resolve server-side',
};

const LIST_SET_META_NOTE = 'A LIST SET META (format 5) on a shared list is charged the shared-list edit fee (LIST_SHARED_EDIT_BASE); whether the list is shared resolves server-side.';

async function checkMisc(ctx) {
    const action = ctx.parsed.action;
    if (action === 'STAKE' && !checkStakeAmountWidth(ctx)) await checkCapabilityStakeBalance(ctx);
    if (Object.prototype.hasOwnProperty.call(ASPECT_NOTES, action) && ASPECT_NOTES[action] === null) return;
    const note = ASPECT_NOTES[action];
    if (note) ctx.addUnverified(action + '_STATE', note);
    else ctx.addUnverified(action + '_STATE', 'no client-side state checks are certified for this action');
    if (action === 'LIST' && String(ctx.parsed.version) === '5') {
        ctx.addUnverified('LIST_SET_META_FEE', LIST_SET_META_NOTE);
    }
}

module.exports = { checkMisc, ASPECT_NOTES, LIST_SET_META_NOTE, STAKE_AMOUNT_MAX_CHARS };
