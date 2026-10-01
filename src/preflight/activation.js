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
 * XChain Platform SDK - pre-flight mirrors of the indexer activation gates
 *
 * Holds the pinned activation tables and their readers; constants.js
 * re-exports every name so the registry keeps one import surface.
 *
 ********************************************************************/

'use strict';

const { FULL_NAME_TO_TICK } = require('../coins/index.js');

// Pin the indexer addGate tables pre-flight decides from; the drift gate compares each by value.
// 'UNARMED' stands for the indexer's UNARMED sentinel, any number is the activation threshold.
const ACTIVATION_MIRRORS = Object.freeze({
    LIST_ADDRESS_REF: Object.freeze({
        key: 'list_address_ref_activation.LIST_ADDRESS_REF_ACTIVATION',
        unit: 'height',
        table: Object.freeze({ mainnet: 'UNARMED', 'BTC:testnet': 'UNARMED', 'LTC:testnet': 'UNARMED',
            'DOGE:testnet': 'UNARMED', testnet: 'UNARMED', regtest: 0 }),
    }),
    LIST_REFERENCE_VALIDITY: Object.freeze({
        key: 'list_reference_validity_activation.LIST_REFERENCE_REQUIRES_VALID_LIST',
        unit: 'height',
        table: Object.freeze({ mainnet: 'UNARMED', 'BTC:testnet': 'UNARMED', 'LTC:testnet': 'UNARMED',
            'DOGE:testnet': 'UNARMED', testnet: 'UNARMED', regtest: 0 }),
    }),
    DISPENSER_SETTLEMENT_PRICE: Object.freeze({
        key: 'dispenser_settlement_price_activation.DISPENSER_SETTLEMENT_PRICE_ACTIVATION',
        unit: 'time',
        table: Object.freeze({ mainnet: 'UNARMED', 'BTC:testnet': 'UNARMED', 'LTC:testnet': 'UNARMED',
            'DOGE:testnet': 'UNARMED', testnet: 'UNARMED', regtest: 0 }),
    }),
});

// Resolve the SDK's network to the registry's (network, coin) pair from config or explorer prefix.
function activationPlane(sdk) {
    const [fullName, plane] = String((sdk && sdk.config && sdk.config.network) || '').toLowerCase().split('-');
    const m = /^([TR]?)(BTC|LTC|DOGE)$/.exec(String((sdk && sdk.explorer && sdk.explorer.coin) || '').toUpperCase());
    const fromCoin = m ? { coin: m[2], network: m[1] === 'T' ? 'testnet' : m[1] === 'R' ? 'regtest' : 'mainnet' } : null;
    if (plane && FULL_NAME_TO_TICK[fullName]) return { coin: FULL_NAME_TO_TICK[fullName], network: plane };
    if (['mainnet', 'testnet', 'regtest'].includes(fullName) && !plane)
        return { coin: fromCoin ? fromCoin.coin : null, network: fullName };
    return fromCoin;
}

// Read a mirrored threshold with the registry's precedence: '<COIN>:<network>' first, then the network.
function activationThreshold(name, sdk) {
    const table = ACTIVATION_MIRRORS[name].table;
    const at = activationPlane(sdk);
    if (!at) return undefined;
    const own = (k) => Object.prototype.hasOwnProperty.call(table, k);
    if (at.coin && own(at.coin + ':' + at.network)) return table[at.coin + ':' + at.network];
    return own(at.network) ? table[at.network] : undefined;
}

// Describe a mirrored table for disclosure text, so the wording moves with the pinned values.
function describeActivation(name) {
    const { table, unit } = ACTIVATION_MIRRORS[name];
    const groups = {};
    for (const k of Object.keys(table)) {
        const state = table[k] === 'UNARMED' ? 'unarmed' : table[k] === 0 ? 'active from genesis' : 'armed at ' + unit + ' ' + table[k];
        (groups[state] = groups[state] || []).push(k);
    }
    return Object.keys(groups).map((state) => state + ' on ' + groups[state].join(', ')).join('; ');
}

module.exports = { ACTIVATION_MIRRORS, activationThreshold, describeActivation };
