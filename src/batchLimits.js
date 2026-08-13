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
 * XChain Platform SDK - BATCH limit scan (client mirror)
 *
 * ONE copy of the consensus arbiter's per-BATCH limit rules
 * (xchain-indexer/src/actions/batch.js, BATCH_ISSUANCE_LIMITS), shared by
 * every client site that used to carry its own: the compose-time builder,
 * the static validator, the decoder mirror and pre-flight. Four copies of
 * a counting rule is how the decoder mirror came to count only the
 * sub-commands that PARSED while the indexer counted every command.
 *
 * The rules, verbatim from the arbiter:
 *
 *  - A BATCH may carry at most ONE top-level (undotted) ISSUE, plus ANY
 *    number of CHILD ISSUEs whose TICK contains a '.'. MINT keeps its
 *    limit of 1; nested BATCH is forbidden outright.
 *  - A caret TICK (`^<id>`) is NEVER exempt, even containing a dot: the
 *    caret form is an id reference and its dot is a decimal, not a
 *    namespace separator. A command with no readable TICK is likewise
 *    top-level; exemption is granted on positive evidence only.
 *  - More than 250 commands rejects the whole batch, and that check runs
 *    FIRST, so a batch breaking the cap AND the ISSUE limit reports the
 *    cap. The count is the raw ';'-split list after the `BATCH|<v>|`
 *    prefix strip, EMPTY elements included.
 *  - Action names are matched CASE-SENSITIVELY, before any upper-casing.
 *    `issue|0|A;issue|0|B` is not two ISSUEs to the arbiter; it dies
 *    earlier as an unknown ACTION, because the activation lookup fails
 *    for an unregistered name. A mirror that upper-cased before
 *    classifying would report a limit the chain never reaches.
 *
 * Classification reads the TICK the EXECUTOR will see: params[1] of the
 * NORMALIZED sub-command (alias rewrite plus the implied legacy VERSION-0
 * injection). The mirror always normalizes, because
 * BATCH_SUBACTION_NORMALIZATION is active on every network a client can
 * compose for.
 *
 ********************************************************************/

'use strict';

const formats = require('./formats.js');
const { ACTION_ALIASES } = require('./decoder/aliases.js');

// Global per-BATCH command cap (indexer batch.js `commandLimit`).
const BATCH_COMMAND_LIMIT = 250;

// Per-ACTION caps, byte-equal to the indexer's `actionLimits` (0 = forbidden
// inside a BATCH). FILE is deliberately ABSENT: its at-most-one rule is a
// client-side transport fact (one rawData payload per transaction), not an
// arbiter limit, and adding it here would make the conformance test compare
// the SDK against a table the indexer does not have.
const BATCH_ACTION_LIMITS = Object.freeze({
    BATCH: 0,
    MINT:  1,
    ISSUE: 1,
});

// Counting bucket for child (dotted-TICK) ISSUEs. Byte-equal to the indexer's
// `childIssueKey`; deliberately not a legal ACTION name so it can never
// collide with a BATCH_ACTION_LIMITS entry and child issuance stays uncapped.
const CHILD_ISSUE_KEY = 'ISSUE.CHILD';

// The three actions whose params take the implied legacy VERSION-0 injection
// (indexer batch.js normalizeSubAction).
const LEGACY_FORMAT_ACTIONS = ['ISSUE', 'MINT', 'SEND'];

// Mirror of xchain-indexer/src/utility.js isLegacyActionFormat: params[0] is
// either a VERSION or, in the pre-VERSION wire form, the TICK. A VERSION is at
// most two characters and numeric; anything else means the field is a TICK and
// the implied VERSION 0 has to be injected in front of it.
function isLegacyActionFormat(params) {
    const version = params[0];
    if (String(version).length > 2) return true;
    if (typeof version === 'string' && !(!isNaN(parseFloat(version)) && isFinite(version))) return true;
    return false;
}

// Alias rewrite, case-sensitive exactly as the arbiter performs it.
function expandAlias(action) {
    return Object.prototype.hasOwnProperty.call(ACTION_ALIASES, action)
        ? ACTION_ALIASES[action]
        : action;
}

// Whether the arbiter would find this (alias-expanded) name registered. Stands
// in for the indexer's `protocolChanges.isEnabled(action)` activation scan: an
// unregistered name - including the empty string an empty command yields - is
// `invalid: ACTION (unknown)` there, whole-batch, before any limit is counted.
function isKnownAction(action) {
    return Object.prototype.hasOwnProperty.call(formats, expandAlias(action));
}

/*
 * Classify one ISSUE TICK value.
 *
 * Returns CHILD_ISSUE_KEY only on positive evidence of a child issuance: a
 * TICK that exists, does not lead with '^', and contains a '.'. Everything
 * else counts against the top-level limit of 1.
 */
function classifyIssueTick(tick) {
    if (tick === undefined || tick === null) return 'ISSUE';
    const t = String(tick);
    if (t.charAt(0) === '^') return 'ISSUE';
    return t.includes('.') ? CHILD_ISSUE_KEY : 'ISSUE';
}

/*
 * Classify one RAW wire sub-command (`ACTION|VERSION|F1|...`, no BATCH prefix)
 * into the key the limit scan counts it under.
 *
 * Mirrors the arbiter's two-step read: the leading token is alias-expanded
 * (case-sensitively, never upper-cased), and only an ISSUE is looked at
 * further - on a PRIVATE split copy, because the legacy VERSION-0 injection
 * mutates the array in place. Never throws: an unreadable command falls back
 * to its unclassified name, which is the arbiter's own fallback.
 */
function classifyCommand(command) {
    const action = expandAlias(String(command).split('|')[0]);
    if (action !== 'ISSUE') return action;
    try {
        const params = String(command).split('|').slice(1);
        if (LEGACY_FORMAT_ACTIONS.includes(action) && isLegacyActionFormat(params))
            params.splice(0, 0, 0);
        return classifyIssueTick(params[1]);
    } catch (e) {
        return action;
    }
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

/*
 * Scan a BATCH COMMAND tail (everything after `BATCH|<version>|`) exactly as
 * the arbiter scans it.
 *
 * Returns { count, counts, violation }:
 *   count      total commands, the raw ';'-split length with empties counted
 *   counts     classification key -> occurrences (every entry, parsed or not)
 *   violation  null, or the FIRST rule broken in the arbiter's own order:
 *              the command cap, then an unknown ACTION, then a per-ACTION cap
 */
function scanBatch(tail) {
    const entries = String(tail).split(';');
    const count = entries.length;

    // The cap runs first, which pins error precedence: a batch that breaks it
    // and other rules reports the cap, never the rule a later loop would find.
    if (count > BATCH_COMMAND_LIMIT)
        return {
            count,
            counts: {},
            violation: { kind: 'COMMAND_LIMIT', action: 'COMMAND', limit: BATCH_COMMAND_LIMIT, count },
        };

    const counts = {};
    for (const entry of entries) {
        const key = classifyCommand(entry);
        counts[key] = (counts[key] || 0) + 1;
    }

    for (const entry of entries) {
        const name = String(entry).split('|')[0];
        if (!isKnownAction(name))
            return { count, counts, violation: { kind: 'ACTION_UNKNOWN', action: name } };
    }

    for (const key of Object.keys(counts)) {
        const limit = BATCH_ACTION_LIMITS[key];
        if (limit !== undefined && counts[key] > limit)
            return { count, counts, violation: { kind: 'ACTION_LIMIT', action: key, limit, count: counts[key] } };
    }

    return { count, counts, violation: null };
}

module.exports = {
    BATCH_COMMAND_LIMIT,
    BATCH_ACTION_LIMITS,
    CHILD_ISSUE_KEY,
    LEGACY_FORMAT_ACTIONS,
    isLegacyActionFormat,
    expandAlias,
    isKnownAction,
    classifyIssueTick,
    classifyCommand,
    paramsTick,
    scanBatch,
};
