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
 * XChain Platform SDK - pre-flight universal checks: native-coin, remote and PRICE v1 tick rules
 *
 ********************************************************************/

'use strict';

const { FINDING_CODES } = require('../constants.js');
const { MAX_TICK_LENGTH } = require('../../protocol/validator/field_limits.js');

/*
 * TICK fields where the chain's NATIVE coin is refused rather than accepted. The
 * native coin is not a token, and these handlers express a native side with an EMPTY
 * tick (or not at all), so naming it resolves no token and is `<FIELD> (unknown)`:
 *   SEND.TICK      send/validate.js:33-34        MINT.TICK     mint/validate.js:92-93
 *   DESTROY.TICK   destroy/validate.js:32-33     AIRDROP.TICK  airdrop/validate.js:34-35
 *   DIVIDEND.TICK and DIVIDEND_TICK  dividend/validate.js:31-36
 *   ORDER.GIVE_TICK order/validate.js:58-59 (native is an empty GIVE_TICK, order/context.js:59)
 *   ORDER.GET_TICK  order/validate.js:64-65, except cross-chain (GET_COIN another chain)
 *   SWAP.GIVE_TICK  swap/validate.js:48-49 and SWAP.GET_TICK swap/validate.js:57-58 (no native
 *                   side; a cross-chain GET is exempt as on ORDER)
 *   DISPENSER.GIVE_TICK dispenser/validate.js:53-54, which has no native give at all, so an
 *   EMPTY GIVE_TICK is refused the same way; DISPENSER.GET_TICK dispenser/validate.js:57-58
 *   (a native price is an empty GET_TICK)
 * Every other field keeps the D-9 exemption below.
 */
const NATIVE_TICK_REFUSED = Object.freeze({
    SEND: ['TICK'], MINT: ['TICK'], DESTROY: ['TICK'], AIRDROP: ['TICK'],
    DIVIDEND: ['TICK', 'DIVIDEND_TICK'], ORDER: ['GIVE_TICK', 'GET_TICK'], SWAP: ['GIVE_TICK', 'GET_TICK'],
    DISPENSER: ['GIVE_TICK', 'GET_TICK'],
});

// PRICE v1 TICK: present and at most MAX_TICK_LENGTH UTF-16 units (price/v1.js:41-43).
function checkPriceV1Tick(ctx) {
    const tick = ctx.field('TICK');
    if (Array.isArray(tick)) return;
    ctx.markRun(FINDING_CODES.VALIDATOR_SEMANTICS);
    if (tick.length > 0 && tick.length <= MAX_TICK_LENGTH) return;
    ctx.addFinding(FINDING_CODES.VALIDATOR_SEMANTICS, 'error',
        `PRICE TICK must be 1-${MAX_TICK_LENGTH} characters; the indexer rejects this PRICE as invalid: TICK (format).`,
        { field: 'TICK', length: tick.length, constraint: { min: 1, max: MAX_TICK_LENGTH } });
}

function isCrossChainGet(ctx, parsed, fieldName, localCoin) {
    if (fieldName !== 'GET_TICK' || (parsed.action !== 'ORDER' && parsed.action !== 'SWAP')) return false;
    if (String(parsed.version) !== '0' || !localCoin) return false;
    const getCoin = ctx.field('GET_COIN');
    return getCoin !== '' && getCoin !== localCoin;
}

function nativeTickRefused(ctx, parsed, fieldName, localCoin) {
    if (!(NATIVE_TICK_REFUSED[parsed.action] || []).includes(fieldName)) return false;
    if (parsed.action === 'ORDER' || parsed.action === 'SWAP' || parsed.action === 'DISPENSER') {
        if (String(parsed.version) !== '0') return false;
        if (parsed.action !== 'DISPENSER' && fieldName === 'GET_TICK' && ctx.field('GET_COIN')
            && ctx.field('GET_COIN') !== localCoin) return false;
    }
    return true;
}

module.exports = { NATIVE_TICK_REFUSED, checkPriceV1Tick, isCrossChainGet, nativeTickRefused };
