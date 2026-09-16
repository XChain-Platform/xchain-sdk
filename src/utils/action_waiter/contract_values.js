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

const ENVELOPE_FIELDS = new Set(['total', 'page', 'limit', 'offset', 'data', 'results']);

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
    if (rows.length) {
        for (let row of rows) {
            if (!row || typeof row !== 'object') continue;
            let key = (row.state_key !== undefined) ? row.state_key : row.key;
            if (key === undefined || key === null) continue;
            let value = (row.state_value !== undefined) ? row.state_value : row.value;
            state[String(key)] = ActionWaiter.parseStateValue(value);
        }
        return state;
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (let key of Object.keys(raw)) {
            if (ENVELOPE_FIELDS.has(key)) continue;
            state[key] = ActionWaiter.parseStateValue(raw[key]);
        }
    }
    return state;
}

// Read one state key through the class hooks so static overrides keep working.
function readContractStateValue(ActionWaiter, raw, key) {
    let rows = ActionWaiter.rowsOf(raw);
    if (rows.length) {
        let state = ActionWaiter.normalizeContractState(raw);
        return Object.prototype.hasOwnProperty.call(state, String(key)) ? state[String(key)] : undefined;
    }
    if (raw && typeof raw === 'object') {
        if (raw.state_value !== undefined) return ActionWaiter.parseStateValue(raw.state_value);
        if (raw.value !== undefined)       return ActionWaiter.parseStateValue(raw.value);
        if (Object.prototype.hasOwnProperty.call(raw, key))
            return ActionWaiter.parseStateValue(raw[key]);
    }
    return undefined;
}

// Read an exact decimal balance string without lossy number conversion.
function readContractQuantity(ActionWaiter, raw, tick) {
    let rows = ActionWaiter.rowsOf(raw);
    if (rows.length) {
        let row = rows.find(r => r && (r.tick === tick || r.TICK === tick));
        if (!row) return null;
        let quantity = (row.quantity !== undefined) ? row.quantity : row.amount;
        return (quantity === undefined || quantity === null) ? null : String(quantity);
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        let quantity = (raw.quantity !== undefined) ? raw.quantity : raw.amount;
        if (quantity !== undefined && quantity !== null) return String(quantity);
    }
    return null;
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
