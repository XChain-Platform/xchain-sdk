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
 * XChain Platform SDK - pre-flight universal checks: the fields judged as amounts
 *
 ********************************************************************/

'use strict';

/*
 * Fields the indexer judges with isValidAmountFormat, so a validator
 * INVALID_FIELD_VALUE on one is a format refusal on chain (AMOUNT_FORMAT_INVALID).
 * Every call site under xchain-indexer src/actions/:
 *   AMOUNT          send/validate.js:41, destroy/validate.js:67, mint/validate.js:128,
 *                   airdrop/validate.js:42, dividend/validate.js:42, bet/validate.js:84,
 *                   deposit.js:149, withdraw.js:158, xbridge/lock_burn.js:133,227
 *   GIVE_AMOUNT     order/validate.js:79, swap/validate.js:70, dispenser/validate_format.js:38
 *   GET_AMOUNT      order/validate.js:87, swap/validate.js:74, dispenser/validate_format.js:88,115
 *   GIVE_ESCROW     dispenser/validate_format.js:45 (formats 0 and 2)
 *   MIN_AMOUNT      bet/create_feed.js:151
 *   MAX_SUPPLY, MAX_MINT, MINT_SUPPLY, CALLBACK_AMOUNT, MINT_ADDRESS_MAX, MINT_START_BLOCK,
 *   MINT_STOP_BLOCK issue/token_state.js:80-84 over fieldList['AMOUNT'] (issue/index.js:143)
 * The name pattern is kept beside the list so no field it already covered drops out.
 */
const AMOUNT_FORMAT_FIELDS = new Set([
    'AMOUNT', 'GIVE_AMOUNT', 'GET_AMOUNT', 'GIVE_ESCROW', 'MIN_AMOUNT', 'MAX_SUPPLY', 'MAX_MINT',
    'MINT_SUPPLY', 'CALLBACK_AMOUNT', 'MINT_ADDRESS_MAX', 'MINT_START_BLOCK', 'MINT_STOP_BLOCK',
]);
function isAmountFormatField(field) {
    return AMOUNT_FORMAT_FIELDS.has(field) || /AMOUNT|QUANTITY|SUPPLY|VALUE/.test(field);
}

// GIVE_ESCROW carries no sign rule on chain: a zero escrow is a dispenser opened to be
// refilled later (xchain-indexer src/actions/dispenser/validate_format.js:66-79), and
// '0' passes the format rule. So the validator's positivity finding on a zero escrow
// stays a warning; a negative one fails the format rule and is refused.
function isChainValidZeroEscrow(details) {
    if (!details || details.field !== 'GIVE_ESCROW') return false;
    const v = String(details.value ?? '').trim();
    return /^0*(\.0*)?$/.test(v) && /0/.test(v);
}

module.exports = { AMOUNT_FORMAT_FIELDS, isAmountFormatField, isChainValidZeroEscrow };
