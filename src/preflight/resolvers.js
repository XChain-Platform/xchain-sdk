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
 * State reconstructable today from existing explorer endpoints:
 * dispenser live lifecycle (the enum matches the field  will
 * add, so the authoritative server value is drop-in later) and
 * DISPENSE give-remaining reconstruction.
 *
 ********************************************************************/

'use strict';

const numeric = require('./numeric.js');

function rows(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw.data)) return raw.data;
    return [];
}

/*
 * Resolve a dispenser's live lifecycle from its event streams.
 * Returns { state: 'open'|'cancelling'|'closed'|'expired'|null,
 *           dispenser } - null state when the dispenser itself is
 * unknown/unfetchable (caller distinguishes via `found`).
 */
async function resolveDispenserState(ctx, dispenserActionIndex) {
    const idx = String(dispenserActionIndex);
    const disp = await ctx.fetch('DISPENSER_LOOKUP', [idx], () =>
        ctx.sdk.explorer.getDispensers(idx, 'action_index'));
    if (!disp.ok) return { found: undefined, state: null, dispenser: null };
    const dRows = rows(disp.value);
    if (dRows.length === 0) return { found: false, state: null, dispenser: null };
    const dispenser = dRows[0];

    // Terminal events, most decisive first.
    const closes = await ctx.fetch('DISPENSER_CLOSES', [idx], () =>
        ctx.sdk.explorer.getDispenserCloses(idx, 'dispenser_action_index'));
    if (closes.ok && rows(closes.value).length > 0)
        return { found: true, state: 'closed', dispenser };

    const expires = await ctx.fetch('DISPENSER_EXPIRES', [idx], () =>
        ctx.sdk.explorer.getDispenserExpires(idx, 'dispenser_action_index'));
    if (expires.ok && rows(expires.value).length > 0)
        return { found: true, state: 'expired', dispenser };

    const cancels = await ctx.fetch('DISPENSER_CANCELS', [idx], () =>
        ctx.sdk.explorer.getDispenserCancels(idx, 'dispenser_action_index'));
    if (cancels.ok && rows(cancels.value).length > 0)
        return { found: true, state: 'cancelling', dispenser };

    return { found: true, state: 'open', dispenser };
}

/*
 * Reconstruct a dispenser's give-remaining from its dispense history:
 * escrow minus the sum of dispensed give-amounts.
 */
async function resolveGiveRemaining(ctx, dispenser, dispenserActionIndex) {
    const idx = String(dispenserActionIndex);
    const escrow = String(dispenser.give_escrow ?? dispenser.GIVE_ESCROW ?? dispenser.escrow ?? '0');
    const res = await ctx.fetch('DISPENSER_DISPENSES', [idx], () =>
        ctx.sdk.explorer.getDispenses(idx, 'dispenser_action_index'));
    if (!res.ok) return null;
    let dispensed = '0';
    for (const row of rows(res.value)) {
        const amt = row.give_amount ?? row.amount ?? row.give_quantity ?? '0';
        dispensed = numeric.add(dispensed, String(amt));
    }
    return numeric.sub(escrow, dispensed);
}

module.exports = { resolveDispenserState, resolveGiveRemaining, rows };
