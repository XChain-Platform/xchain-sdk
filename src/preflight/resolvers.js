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
 * XChain Platform SDK - pre-flight client resolvers (spec §7)
 *
 * Dispenser live lifecycle and give-remaining, both read from the
 * explorer's ACTION-DETAIL route (`/{COIN}/api/action/{index}`, SDK
 * `explorer.getAction`). That route is the only one keyed by action
 * index, and it is also the only one carrying the derived `state`
 * block the indexer's own validity checks compare against:
 *
 *     state: { give_remaining, status, expiration, allow_list, block_list }
 *
 * `give_remaining` there is escrow PLUS every valid refill MINUS every
 * dispense (xchain-explorer db.js), and `status` is the same value
 * dispense.js gates on ("dispenser not open"), so both are read rather
 * than reconstructed.
 *
 * These resolvers previously fanned out across /dispensers/,
 * /dispenser_closes/, /dispenser_expires/, /dispenser_cancels/ and
 * /dispenses/, keyed by `action_index` / `dispenser_action_index`.
 * NONE of those routes accept those types (/dispensers/ takes block,
 * address, source, destination, token, oracle; the lifecycle routes
 * take block, address), so every one of those calls 404'd and every
 * DISPENSE pre-flight reported a live dispenser as nonexistent - a
 * blanket false block on the one action §4.4 says the client tier is
 * the only pre-sign protection for. Unit mocks answered to the invented
 * shape, so the suite stayed green over an API that does not exist;
 * that is why the fixtures in the test suite now mirror a REAL captured
 * payload.
 *
 ********************************************************************/

'use strict';

function rows(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw.data)) return raw.data;
    return [];
}

// The action route answers with the record itself, or wrapped in `data`.
function actionRecord(raw) {
    if (!raw) return null;
    const rec = (raw.data && !Array.isArray(raw.data)) ? raw.data : raw;
    if (Array.isArray(rec)) return rec[0] || null;
    return (rec && typeof rec === 'object') ? rec : null;
}

/*
 * Resolve a dispenser and its live lifecycle by action index.
 *
 * Returns { found, state, dispenser }:
 *   found === undefined  the lookup itself was unavailable (unverified)
 *   found === false      no such action, or it is not a DISPENSER
 *   state  === null      it is a dispenser, but the route served no status
 *                        (unknown, NOT "open" - callers must not read
 *                        silence as a green light)
 *
 * `state` is passed through verbatim rather than mapped onto a fixed
 * enum. The indexer gates on `status != 'open'` and keeps minting new
 * terminal strings (`empty`, `max_dispenses_reached`), so anything-but-
 * open is the rule that cannot go stale as those are added.
 */
async function resolveDispenserState(ctx, dispenserActionIndex) {
    const idx = String(dispenserActionIndex);
    const res = await ctx.fetch('DISPENSER_LOOKUP', [idx], () =>
        ctx.sdk.explorer.getAction(idx));
    if (!res.ok) return { found: undefined, state: null, dispenser: null };

    const record = actionRecord(res.value);
    if (!record) return { found: false, state: null, dispenser: null };
    if (String(record.action || '').toUpperCase() !== 'DISPENSER')
        return { found: false, state: null, dispenser: null };

    const status = String(record.state?.status ?? record.dispenser_status ?? '').toLowerCase();
    return { found: true, state: status || null, dispenser: record };
}

/*
 * A dispenser's give-remaining, or null when it cannot be known.
 *
 * Read, never reconstructed. Reconstructing it from the opening
 * GIVE_ESCROW minus dispenses looks reasonable and is wrong: a format-2
 * DISPENSER_EDIT refills the escrow, and no endpoint exposes per-edit
 * give_escrow (/dispenser_edits/ omits the column entirely), so the
 * reconstruction can only ever run LOW. Running low here means
 * DISPENSER_EMPTY at severity error on a DISPENSE, i.e. telling a user a
 * purchase will fail when the chain would settle it - so when the
 * derived figure is absent the honest answer is "unknown" and the caller
 * declares the check unverified.
 */
async function resolveGiveRemaining(ctx, dispenser, dispenserActionIndex) {
    const live = dispenser?.state?.give_remaining ?? dispenser?.give_remaining;
    if (live !== undefined && live !== null) return String(live);
    // Keep the argument in the signature: callers pass the index and a
    // future authoritative field may need its own lookup.
    void dispenserActionIndex; void ctx;
    return null;
}

module.exports = { resolveDispenserState, resolveGiveRemaining, actionRecord, rows };
