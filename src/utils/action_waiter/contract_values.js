/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * XChain Platform SDK - Action Waiter
 *
 * Resolves when the indexer processes a specific transaction.
 * Uses WebSocket events with polling fallback.
 *
 ********************************************************************/

const mathjs = require('mathjs');

// Unpack explorer result rows so callers can accept both response shapes.
function rowsOf(raw) {
    if (Array.isArray(raw)) return raw;
    if (raw && Array.isArray(raw.data)) return raw.data;
    return [];
}

// Parse state JSON while preserving values that are already typed or malformed.
function parseStateValue(value) {
    if (value === undefined || value === null) return value === undefined ? undefined : null;
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch (e) { return value; }
}

// Normalize state through the class hooks so static overrides keep working.
function normalizeContractState(ActionWaiter, raw) {
    let state = Object.create(null);
    let rows  = ActionWaiter.rowsOf(raw);
    for (let row of rows) {
        if (!row || typeof row !== 'object') continue;
        let key = row.state_key;
        if (key === undefined || key === null) continue;
        state[String(key)] = ActionWaiter.parseStateValue(row.state_value);
    }
    return state;
}

// Read one state key through the class hooks so static overrides keep working.
function readContractStateValue(ActionWaiter, raw, key) {
    let state = ActionWaiter.normalizeContractState(raw);
    return Object.prototype.hasOwnProperty.call(state, String(key)) ? state[String(key)] : undefined;
}

// Read an exact decimal balance string without lossy number conversion.
function readContractQuantity(ActionWaiter, raw, tick) {
    let rows = ActionWaiter.rowsOf(raw);
    let balance = rows.find(candidate => candidate && candidate.tick === tick);
    if (!balance || balance.amount === undefined || balance.amount === null) return null;
    return String(balance.amount);
}

// Compare exact decimal quantities so large adjacent values remain distinct.
function compareAmount(a, b) {
    try {
        return mathjs.bignumber(String(a)).cmp(mathjs.bignumber(String(b)));
    } catch (e) {
        return -1;
    }
}

module.exports = {
    rowsOf,
    parseStateValue,
    normalizeContractState,
    readContractStateValue,
    readContractQuantity,
    compareAmount
};
