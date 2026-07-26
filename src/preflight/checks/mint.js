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
 * Pre-flight Tier-2: MINT (spec §4.4; mirrors xchain-indexer
 * src/actions/mint.js:81-220). Two caps, no fee: per-tx MAX_MINT and
 * MAX_SUPPLY headroom. Per-address headroom, allow/block lists,
 * quotable guard, and the self-mint flag are internal/Tier-1-only.
 *
 ********************************************************************/

'use strict';

const { FINDING_CODES } = require('../constants.js');
const numeric = require('../numeric.js');

/*
 * Read a scalar off a token document, trying each candidate in order.
 *
 * Candidates may be DOTTED PATHS, because the explorer's `/token/{tick}`
 * document is nested and none of the fields these checks want are at the top
 * level:
 *
 *     { info:   { coin, tick, description, owner, tick_id, decimals },
 *       mints:  { max, address_max, start_block, stop_block },
 *       supply: { current, max, decimals },
 *       locks:  { ..., max_mint, max_supply, ... },   <-- BOOLEANS, not values
 *       market, lists, controllers, callback, ... }
 *
 * The flat names are kept after the paths as a hedge for other explorer
 * builds, but they are the fallback now, not the expectation. Reading only
 * flat names is what made MINT_OVER_MAX, SUPPLY_EXCEEDED and NOT_OWNER
 * unable to fire at all against the real API - three certified error-capable
 * Tier-2 checks that silently passed everything, which is indistinguishable
 * from a check that ran and found nothing.
 *
 * Note `locks.max_mint` is a lock FLAG, not the cap; a flat `max_mint` lookup
 * must never be allowed to drift onto it.
 *
 * Objects are rejected rather than stringified: top-level `supply` IS an
 * object here, and String()-ing it yields '[object Object]', which would then
 * flow into the numeric comparisons as garbage.
 */
function tokenField(token, names) {
    for (const n of names) {
        let v = token;
        for (const part of n.split('.')) {
            if (v === null || v === undefined || typeof v !== 'object') { v = undefined; break; }
            v = v[part];
        }
        if (v === undefined || v === null || v === '' || typeof v === 'object') continue;
        return String(v);
    }
    return null;
}

async function checkMint(ctx) {
    const tick = ctx.field('TICK');
    const amount = ctx.field('AMOUNT');
    if (!tick || Array.isArray(tick)) return;

    const token = await ctx.token(tick);
    if (token === undefined || token === null) {
        // Universal token-exists already errored on null; nothing
        // further is checkable either way.
        if (token === undefined) ctx.addUnverified(FINDING_CODES.MINT_OVER_MAX, 'token lookup unavailable');
        return;
    }

    if (amount && !numeric.isPositive(amount)) {
        ctx.addFinding(FINDING_CODES.AMOUNT_NOT_POSITIVE, 'warning',
            'Mint amount is not positive.', { amount });
    }

    const maxMint = tokenField(token, ['mints.max', 'max_mint', 'MAX_MINT', 'maxMint']);
    ctx.markRun(FINDING_CODES.MINT_OVER_MAX);
    if (maxMint && amount && numeric.gt(amount, maxMint)) {
        ctx.addFinding(FINDING_CODES.MINT_OVER_MAX, 'error',
            `Mint amount ${amount} exceeds the per-transaction MAX_MINT ${maxMint} for ${tick}.`,
            { tick, amount, maxMint });
    }

    const maxSupply = tokenField(token, ['supply.max', 'max_supply', 'MAX_SUPPLY', 'maxSupply']);
    const supply = tokenField(token, ['supply.current', 'supply', 'SUPPLY', 'current_supply', 'total_supply']);
    ctx.markRun(FINDING_CODES.SUPPLY_EXCEEDED);
    if (maxSupply && supply !== null && amount) {
        const headroom = numeric.sub(maxSupply, supply);
        if (numeric.gt(amount, headroom)) {
            ctx.addFinding(FINDING_CODES.SUPPLY_EXCEEDED, 'error',
                `Mint amount ${amount} exceeds the remaining supply headroom ${headroom} for ${tick}.`,
                { tick, amount, maxSupply, supply, headroom });
        }
    }

    // Amount format vs the tick's decimals (vendored consensus rule).
    const decimals = tokenField(token, ['supply.decimals', 'info.decimals', 'decimals', 'DECIMALS']);
    if (decimals !== null && amount && !numeric.isValidAmountFormat(decimals, amount)) {
        ctx.addFinding(FINDING_CODES.AMOUNT_FORMAT_INVALID, 'error',
            `Mint amount ${amount} is not a valid amount at ${decimals} decimals.`,
            { tick, amount, decimals });
    }

    ctx.addUnverified('MINT_ADDRESS_HEADROOM',
        'per-address minted headroom, allow/block lists, and mint-guard outcome are server-side only');
}

module.exports = { checkMint, tokenField };
