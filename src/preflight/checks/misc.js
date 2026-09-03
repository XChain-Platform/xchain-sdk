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
 * matrix rows harden (§4.4 remains the roadmap).
 *
 ********************************************************************/

'use strict';

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
    DEPOSIT:  'contract active-state resolves server-side',
    WITHDRAW: 'deployer-only gate and contract credit resolve server-side',
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
    LIST:     'per-item validity is recorded per-item on-chain, never a reject',
    ADDRESS:  'contract bindability and live-bind state resolve server-side',
    PRICE:    'oracle authority (capability stake) resolves server-side',
    SLEEP:    'ownership, lock, and escrow state resolve server-side',
};

async function checkMisc(ctx) {
    const action = ctx.parsed.action;
    if (Object.prototype.hasOwnProperty.call(ASPECT_NOTES, action) && ASPECT_NOTES[action] === null) return;
    const note = ASPECT_NOTES[action];
    if (note) ctx.addUnverified(action + '_STATE', note);
    else ctx.addUnverified(action + '_STATE', 'no client-side state checks are certified for this action');
}

module.exports = { checkMisc, ASPECT_NOTES };
