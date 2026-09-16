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
 * XChain Platform SDK - decoder.describe
 *
 * Plain-English action describer, promoted from the wallet
 * (packages/core/src/decoder/actionDecoder.js). Pure
 * function (no vault, no network); both wallet shells and any SDK
 * consumer render the same {summary, details, warnings} contract.
 *
 * Dedicated describers: ADDRESS, SEND, SWEEP, ISSUE (v0-v7), MINT,
 * DESTROY, BATCH, BROADCAST, DISPENSER, DIVIDEND, LIST, AIRDROP, ORDER,
 * SWAP, STAKE, UNSTAKE, DELEGATE, VOTE, DEPLOY, EXECUTE, DEPOSIT,
 * WITHDRAW, COINPAY, COLLECT, MESSAGE, FILE, LINK, SLEEP, CALLBACK,
 * PRICE, BET, XBRIDGE - i.e. every ACTION in formats.js, which
 * `test/unit/decoder/describe.test.js` enumerates rather than trusting
 * this list: the confirm screen is where a user verifies intent
 * before signing, so a missing case there is a coverage hole on the
 * security surface, not a cosmetic gap.
 *
 * A future action added to formats.js with no case here gets the generic
 * fallback (which still names the action and lists every parameter) and
 * fails that enumeration test. Untrusted-input hardening (bidi/zero-width
 * neutralization, canonical amount flags, own-address/contact
 * marking) is applied centrally to the finished output - see
 * hardening.js and harden() below.
 *
 ********************************************************************/

'use strict';

const { actionDisplayLabel } = require('../action_display_label.js');

// Scale the multi-send per-token totals are summed at: 18 dp, the finest precision any
// tick can be issued with (MAX_TOKEN_DECIMALS), so no legal leg loses digits.
const TOTAL_SCALE = 1000000000000000000n;

// A plain unsigned decimal string to an exact BigInt count of 10^-18 units, or null when
// the leg is not one. Number()+`+` is not exact enough for the one figure a user reads as
// what the transaction moves: 0.1 and 0.2 add to 0.30000000000000004, an 18-decimal tick
// loses its tail, and a leg above 2^53 base units collapses to a nearby double before it
// is ever added. null is what makes the caller omit the total instead of guessing it.
function toScaledUnits(value) {
    const s = String(value === null || value === undefined ? '' : value).trim();
    const m = /^(\d+)(?:\.(\d{1,18}))?$/.exec(s);
    if (m === null) return null;
    return BigInt(m[1]) * TOTAL_SCALE + BigInt((m[2] || '').padEnd(18, '0'));
}

// Scaled units back to a plain decimal string, trailing zeros trimmed so a whole total
// still reads '11' rather than '11.000000000000000000'.
function fromScaledUnits(units) {
    const whole = (units / TOTAL_SCALE).toString();
    const frac = (units % TOTAL_SCALE).toString().padStart(18, '0').replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : whole;
}

function getCoinLabel(coin) {
    return coin ? `${coin} (native coin)` : '';
}

/*
 * Collect human-readable names of every lock flag the ISSUE params
 * turn on. Any truthy value (including the serialized "1") counts.
 */
function collectLockFlags(p) {
    const flags = [
        ['LOCK_MAX_SUPPLY', 'max supply'],
        ['LOCK_MAX_MINT', 'max mint'],
        ['LOCK_MINT', 'minting'],
        ['LOCK_MINT_SUPPLY', 'mint-supply'],
        ['LOCK_DESCRIPTION', 'description'],
        ['LOCK_SLEEP', 'sleep'],
        ['LOCK_CALLBACK', 'callback'],
    ];
    const active = [];
    for (const [field, label] of flags) {
        const v = p[field];
        if (v === undefined || v === null || v === '' || v === '0' || v === 0 || v === false) continue;
        active.push(label);
    }
    return active;
}

function genericFallback(action, p, chainSuffix) {
    // Param keys are raw wire fields (TICK, GAS_LIMIT); title-case them
    // directly rather than via actionDisplayLabel, whose action-name map
    // would mistranslate keys that collide with action verbs (e.g. LIST).
    const humanizeKey = (k) => {
        const words = String(k).trim().toLowerCase().replace(/[_-]+/g, ' ');
        return words.charAt(0).toUpperCase() + words.slice(1);
    };
    const paramEntries = Object.entries(p)
        .filter(([k]) => k !== 'VERSION')
        .map(([k, v]) => ({
            label: humanizeKey(k),
            value: typeof v === 'string' ? v : safeJson(v),
        }));
    const verb = action ? actionDisplayLabel(action) : 'unknown action';
    return {
        summary: `Sign ${verb}${chainSuffix}`,
        details: paramEntries,
        warnings: [
            `No plain-English summary is available for "${verb}" yet. Review the parameters carefully before approving.`,
        ],
    };
}

function str(v) {
    if (v === undefined || v === null) return '';
    if (Array.isArray(v)) return v.map((x) => str(x)).join(', ');
    return String(v);
}

// First slot of a multi-leg array field, else the value itself.
function firstStr(v) {
    return String(v).split(', ')[0];
}

function toArray(v) {
    if (v === undefined || v === null || v === '') return [];
    if (Array.isArray(v)) return v.filter((x) => x !== undefined && x !== null && x !== '');
    return [v];
}

function safeJson(v) {
    try {
        return JSON.stringify(v);
    } catch (_err) {
        return String(v);
    }
}

module.exports = { TOTAL_SCALE, toScaledUnits, fromScaledUnits, getCoinLabel, collectLockFlags, genericFallback, str, firstStr, toArray, safeJson };
