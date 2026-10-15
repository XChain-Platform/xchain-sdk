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
 * src/actions/mint.js:81-220). The LOCK_MINT lock and two caps, no fee:
 * per-tx MAX_MINT and MAX_SUPPLY headroom. Per-address headroom, allow/block lists,
 * quotable guard, and the self-mint flag are internal/Tier-1-only.
 *
 ********************************************************************/

'use strict';

const { FINDING_CODES } = require('../constants.js');
const numeric = require('../numeric.js');
const { amountFormatOk, declareRepresentability } = require('./amount_format.js');

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

function checkMintLimit(ctx, tick, amount, token) {
    // mint.js (xchain-indexer) stores MAX_MINT as 0 when an ISSUE omits it,
    // and treats 0 as "no per-tx cap" (guards with bcgt(MAX_MINT,0)) rather
    // than a real zero-mint cap; mirror that here or every mint on a
    // no-MAX_MINT token is flagged as exceeding a cap that doesn't exist.
    const maxMint = tokenField(token, ['mints.max', 'max_mint', 'MAX_MINT', 'maxMint']);
    const maxMintCap = maxMint && numeric.isPositive(maxMint) ? maxMint : null;
    ctx.markRun(FINDING_CODES.MINT_OVER_MAX);
    if (maxMintCap && amount && numeric.gt(amount, maxMintCap)) {
        ctx.addFinding(FINDING_CODES.MINT_OVER_MAX, 'error',
            `Mint amount ${amount} exceeds the per-transaction MAX_MINT ${maxMint} for ${tick}.`,
            { tick, amount, maxMint });
    }
}

// A token whose LOCK_MINT is set refuses every MINT, ahead of every amount rule
// (xchain-indexer src/actions/mint/validate.js:121-123). The explorer serves the lock
// as a boolean flag at locks.mint. MINT_OVER_MAX is the certified code nearest the
// verdict: the mint is refused for its token's mint terms, not its format.
function checkMintLock(ctx, tick, token) {
    const lock = token && token.locks && typeof token.locks === 'object' ? token.locks.mint : undefined;
    const flat = token ? (token.lock_mint ?? token.LOCK_MINT) : undefined;
    const locked = lock === true || lock === 1 || lock === '1' || flat === true || flat === 1 || flat === '1';
    ctx.markRun(FINDING_CODES.MINT_OVER_MAX);
    if (locked) {
        ctx.addFinding(FINDING_CODES.MINT_OVER_MAX, 'error',
            `${tick} has LOCK_MINT set, so no more can be minted; the indexer refuses this MINT as invalid: LOCK_MINT.`,
            { tick, lockMint: true });
    }
}

function checkSupplyLimit(ctx, tick, amount, token) {
    const maxSupply = tokenField(token, ['supply.max', 'max_supply', 'MAX_SUPPLY', 'maxSupply']);
    const supply = tokenField(token, ['supply.current', 'supply', 'SUPPLY', 'current_supply', 'total_supply']);
    // MAX_SUPPLY=0 is the UNCAPPED sentinel, exactly as MAX_MINT=0 is above, and it
    // needs its own guard for a reason the MAX_MINT case does not expose: tokenField
    // returns strings, and '0' is TRUTHY, so this ran with maxSupply=0 and a NEGATIVE
    // headroom, turning every mint on an uncapped token into an error. At/after the
    // UNCAPPED_MAX_SUPPLY_ZERO flag-day the chain accepts exactly those mints
    // (xchain-indexer src/actions/mint.js), so the finding false-blocked a
    // valid action, which spec §4.2 forbids.
    //
    // Declared unverified rather than dropped: BELOW the flag-day the handler still
    // rejects them ('invalid: mint exceeds MAX_SUPPLY'), and pre-flight has no chain
    // height to tell the two eras apart, so silence would read as "checked, fine".
    const supplyCap = maxSupply && numeric.isPositive(maxSupply) ? maxSupply : null;
    ctx.markRun(FINDING_CODES.SUPPLY_EXCEEDED);
    if (maxSupply && !supplyCap) {
        ctx.addUnverified(FINDING_CODES.SUPPLY_EXCEEDED,
            `${tick} declares MAX_SUPPLY=0 (uncapped); whether a mint is accepted depends on the `
            + 'UNCAPPED_MAX_SUPPLY_ZERO activation height, which pre-flight cannot read');
    } else if (supplyCap && supply !== null && amount) {
        const headroom = numeric.sub(supplyCap, supply);
        if (numeric.gt(amount, headroom)) {
            ctx.addFinding(FINDING_CODES.SUPPLY_EXCEEDED, 'error',
                `Mint amount ${amount} exceeds the remaining supply headroom ${headroom} for ${tick}.`,
                { tick, amount, maxSupply, supply, headroom });
        }
    }
}

function checkMintAmountFormat(ctx, tick, amount, token) {
    // Amount format vs the tick's decimals (vendored consensus rule).
    const decimals = tokenField(token, ['supply.decimals', 'info.decimals', 'decimals', 'DECIMALS']);
    if (decimals !== null && amount && !amountFormatOk(ctx, decimals, amount)) {
        ctx.addFinding(FINDING_CODES.AMOUNT_FORMAT_INVALID, 'error',
            `Mint amount ${amount} is not a valid amount at ${decimals} decimals.`,
            { tick, amount, decimals });
    }
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

    checkMintLock(ctx, tick, token);
    checkMintLimit(ctx, tick, amount, token);
    checkSupplyLimit(ctx, tick, amount, token);
    checkMintAmountFormat(ctx, tick, amount, token);

    // The amount-format check above applies the representability rule where it is
    // armed; everywhere else the rule is declared.
    declareRepresentability(ctx);

    ctx.addUnverified('MINT_ADDRESS_HEADROOM',
        'per-address minted headroom, allow/block lists, and mint-guard outcome are server-side only');
}

module.exports = { checkMint, tokenField };
