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
 ********************************************************************/

'use strict';

const { LEGACY_FORMAT_ACTIONS, isLegacyActionFormat, expandAlias } = require('./limit_tables.js');
const { classifyCommand } = require('./command_classification.js');

/*
 * Read the TICK a sub-command's handler will parse, out of a RAW wire command.
 *
 * Mirror of the arbiter's `subCommandTick`: params[1] of the NORMALIZED
 * sub-command, on a PRIVATE split copy because the legacy VERSION-0 injection
 * splices in place, trimmed, and '' when there is no TICK at all. Never
 * throws; callers read '' as "no positive evidence", never as a token named
 * the empty string.
 */
function commandTick(command) {
    try {
        const action = expandAlias(String(command).split('|')[0]);
        const params = String(command).split('|').slice(1);
        if (LEGACY_FORMAT_ACTIONS.includes(action) && isLegacyActionFormat(params))
            params.splice(0, 0, 0);
        const tick = params[1];
        if (tick === undefined || tick === null) return '';
        return String(tick).trim();
    } catch (e) {
        return '';
    }
}

/*
 * The DISTINCT classification keys of a command list, in the order each one's
 * FIRST command appears.
 *
 * This is the ONE expression of spec R2b for the client side: among per-ACTION
 * caps, the error names the action whose first sub-command appears EARLIEST in
 * the batch's command list. The SDK's cap loop (decoder/parse.js) walks this
 * list, and the arbiter walks its own list-driven copy, so the two agree by
 * rule instead of by coincidence.
 *
 * Derived from the LIST rather than from a tally's keys deliberately. A plain
 * object enumerates string keys by insertion, which HAPPENED to match this
 * order, but nothing said so: a refactor to a Map, a sort, or a second counting
 * pass would have moved a consensus error string with no rule to stop it, and
 * an integer-like key (which an unknown ACTION name can be) jumps the queue on
 * a plain object regardless of insertion. Do not fold this back into
 * `Object.keys(counts)`.
 */
function limitKeysInListOrder(entries) {
    const seen = new Set();
    const order = [];
    for (const entry of entries) {
        const key = classifyCommand(entry);
        if (seen.has(key)) continue;
        seen.add(key);
        order.push(key);
    }
    return order;
}

/*
 * Read a TICK out of a compose-time params OBJECT (the builder's shape, before
 * anything is serialized). Matches the canonical field under any of the key
 * spellings createAction accepts (TICK / tick / Tick), and only that field:
 * GIVE_TICK and friends normalize to different names.
 */
function paramsTick(params) {
    if (!params || typeof params !== 'object') return undefined;
    for (const key of Object.keys(params))
        if (key.replace(/_/g, '').toLowerCase() === 'tick') return params[key];
    return undefined;
}

module.exports = {
    commandTick,
    limitKeysInListOrder,
    paramsTick,
};
