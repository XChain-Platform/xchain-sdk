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
 * GIVE_COIN / GET_COIN defaults for ORDER, SWAP and DISPENSER creates.
 *
 * The indexer requires both COIN fields to name a supported coin, compared
 * exactly, so a create that leaves either empty can never be valid. The
 * native coin is written as COIN=<coin> with an EMPTY tick; a TICK holding
 * the coin's own name is read on chain as a token lookup and fails.
 *
 * A TICK equal to its own side's COIN is always that chain's native coin,
 * since a coin's name is reserved on its own chain, so the TICK is cleared.
 * With no COIN given, only this network's coin is read as native: another
 * coin's name may be a bridged origin root token here, so it stays a TICK.
 *
 ********************************************************************/

const coins = require('../coins');

const INDEX_FIELD = { ORDER: 'ORDER_ACTION_INDEX', SWAP: 'SWAP_ACTION_INDEX', DISPENSER: 'DISPENSER_ACTION_INDEX' };

function isEmpty(value) {
    return value === undefined || value === null || value === '';
}

// 'dogecoin-testnet' -> 'DOGE'; null when the network is unset or unknown.
function networkCoin(network) {
    if (!network) return null;
    let fullName = String(network).split('-')[0].toLowerCase();
    return Object.prototype.hasOwnProperty.call(coins.FULL_NAME_TO_TICK, fullName)
         ? coins.FULL_NAME_TO_TICK[fullName]
         : null;
}

// A supported coin named in any case, in the exact case the indexer compares.
function canonicalCoin(value) {
    let upper = String(value).toUpperCase();
    return coins.ALLOWED_COINS.includes(upper) ? upper : value;
}

// Fills one side's COIN field and clears a TICK that names that side's coin.
// A DISPENSER always gives a token, so its GIVE side keeps whatever tick it has.
function fillSide(fields, action, side, coin) {
    let coinKey = side + '_COIN';
    let tickKey = side + '_TICK';
    if (!isEmpty(fields[coinKey]))
        fields[coinKey] = canonicalCoin(fields[coinKey]);
    else if (coin)
        fields[coinKey] = coin;
    let tick = isEmpty(fields[tickKey]) ? null : String(fields[tickKey]).toUpperCase();
    if (tick !== null && tick === fields[coinKey] && !(action === 'DISPENSER' && side === 'GIVE'))
        delete fields[tickKey];
}

// Mutates and returns `fields` (already UPPER_SNAKE). Leaves cancels and edits,
// which carry an action index and no COIN fields, untouched.
function fillMarketCoinFields(fields, action, network) {
    let indexField = INDEX_FIELD[action];
    if (!indexField || !fields || !isEmpty(fields[indexField])) return fields;
    if (!isEmpty(fields.VERSION) && Number(fields.VERSION) !== 0) return fields;
    let coin = networkCoin(network);
    fillSide(fields, action, 'GIVE', coin);
    fillSide(fields, action, 'GET', coin);
    return fields;
}

module.exports = { fillMarketCoinFields, networkCoin };
