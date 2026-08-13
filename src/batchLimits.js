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
 *    number of CHILD ISSUEs whose TICK contains a '.'. Nested BATCH is
 *    forbidden outright, DEPLOY is capped at 1 and MINT at one per
 *    DISTINCT token.
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
 * WHICH SIDE OF THE FLAG THIS MIRROR SPEAKS FOR
 *
 * The POST-flag rule set, unconditionally, on every network. That is not a
 * new posture: the 250-command cap (a tightening) and the dotted-TICK
 * exemption (a loosening) both shipped that way already, and a client that
 * switched rule sets on a chain clock would compose one thing and validate
 * another. It has a cost worth stating plainly rather than discovering:
 * BATCH_ISSUANCE_LIMITS is UNARMED on mainnet, so a batch this mirror
 * accepts under a loosened rule (a parent plus children, MINTs of several
 * distinct tokens) is rejected by mainnet until the flag is armed.
 * DEPLOY is the one rule where both sides agree: the chain never capped it
 * below the flag, so at most 1 is accepted either way.
 *
 * THE MIRROR CANNOT BE EXACT ON MINT, AND SAYS SO
 *
 * D7 defines MINT distinctness on the RESOLVED TICKER ID. A client holds
 * strings and cannot resolve them, so this mirror is a declared
 * CONSERVATIVE APPROXIMATION with two known divergences, both pinned by
 * deliberate conformance vectors rather than left to be found later:
 *
 *  1. THE CARET ALIAS, detectable. `JDOG` and `^614` can name ONE token,
 *     so two MINTs spelled both ways are one token to the arbiter and two
 *     strings here. Detectable because the caret form is visible in the
 *     wire text, so the compose-side sites REFUSE the shape and tell the
 *     caller to spell the TICK by name; scanBatch, which decodes rather
 *     than composes, reports it as `approximate` instead of inventing a
 *     verdict it cannot support.
 *  2. UNRESOLVABLE TICKS, undetectable. The arbiter buckets every TICK
 *     that resolves to no id TOGETHER, so two MINTs of two not-yet-created
 *     tokens are one bucket and one reject there, two distinct strings
 *     here. A client cannot know which names exist without asking an
 *     indexer, so this one is DECLARED, not closed. Such a MINT is invalid
 *     at execution regardless, so the batch it lets through was never
 *     going to land.
 *
 * Both divergences run in the SAME direction: this mirror may accept a
 * batch the chain rejects, never the reverse. That is the direction a
 * client can survive (a rejected broadcast) rather than the one it cannot
 * (silently refusing legal work).
 *
 * ONE NAME, TWO MEANINGS - read this before importing either
 *
 * `BATCH_ACTION_LIMITS` here is the UNGATED table, because this module's job
 * is to state the arbiter's two tables separately and faithfully. The name
 * `decoder/parse.js` exports is the ACTIVE (merged) table, because that one
 * is a public decoder API and a caller reading it is asking what `parse()`
 * enforces, not what applied before the flag. Both are deliberate; import
 * `BATCH_ACTION_LIMITS_ACTIVE` by name when you want the enforced set and
 * the ambiguity cannot reach you.
 *
 ********************************************************************/

'use strict';

const formats = require('./formats.js');
const { ACTION_ALIASES } = require('./decoder/aliases.js');

// Global per-BATCH command cap (indexer batch.js `commandLimit`).
const BATCH_COMMAND_LIMIT = 250;

// Per-ACTION caps, byte-equal to the indexer's UNGATED `actionLimits`
// (0 = forbidden inside a BATCH). FILE is deliberately ABSENT: its
// at-most-one rule is a client-side transport fact (one rawData payload per
// transaction), not an arbiter limit, and adding it here would make the
// conformance test compare the SDK against a table the indexer does not have.
//
// MINT's 1 is re-read at/after the flag as "1 per DISTINCT token" (D7), which
// is why the number stays here and only what it is COMPARED AGAINST moves.
const BATCH_ACTION_LIMITS = Object.freeze({
    BATCH: 0,
    MINT:  1,
    ISSUE: 1,
});

// Caps the arbiter merges over the table above at/after BATCH_ISSUANCE_LIMITS,
// byte-equal to the indexer's `gatedActionLimits` (D5). Kept as a SEPARATE
// table for the same reason the arbiter keeps one: DEPLOY is uncapped below
// the flag, and folding it into the ungated table would state a rule that
// never applied there.
const BATCH_GATED_ACTION_LIMITS = Object.freeze({
    DEPLOY: 1,
});

// What this mirror actually enforces (see the header: the post-flag rule set).
const BATCH_ACTION_LIMITS_ACTIVE = Object.freeze(
    Object.assign({}, BATCH_ACTION_LIMITS, BATCH_GATED_ACTION_LIMITS));

// Distinctness bucket for a MINT TICK carrying no positive evidence of a
// token. A Symbol for the arbiter's reason: it can never collide with a real
// key however a wire tick is spelled.
const UNRESOLVED_TICK_KEY = Symbol('BATCH_UNRESOLVED_TICK');

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
 * Distinctness key for ONE MINT TICK, client-side.
 *
 * The arbiter keys on the RESOLVED ticker id; this keys on the literal
 * string, which is exact for plain names (a name maps 1:1 to an id) and
 * inexact for the two cases the header declares. Returns
 * { key, aliasable }: `aliasable` marks a caret TICK, the divergence a
 * client CAN see, so compose-side callers can refuse the shape rather than
 * guess at it.
 */
function mintTickKey(tick) {
    const t = (tick === undefined || tick === null) ? '' : String(tick).trim();
    // '' is the arbiter's own unresolvable case (it never probes an empty
    // tick), so the mirror can reproduce that bucket exactly.
    if (t === '') return { key: UNRESOLVED_TICK_KEY, aliasable: false };
    if (t.charAt(0) === '^') return { key: t, aliasable: true };
    return { key: t, aliasable: false };
}

/*
 * Largest number of MINT sub-commands naming ONE token, over a batch's MINT
 * TICKs in list order (the arbiter's `maxMintsPerDistinctTick`).
 *
 * Returns { max, approximate }. `approximate` marks divergence 1 from the
 * header - a caret that might be aliasing a token named elsewhere in the same
 * batch - and it is true ONLY when a caret key coexists with a NON-caret key.
 * Nothing else is in doubt on that axis:
 *
 *  - two DISTINCT caret ids are two distinct tokens BY CONSTRUCTION, so an
 *    all-caret set needs no resolution at all. Flagging it would be an
 *    everyday false alarm rather than an edge case: `tickResolver` compacts a
 *    MINT's TICK to `^<id>` before serializing, so all-caret is the shape the
 *    builder itself normally emits, and a compose site refusing on the raw
 *    flag refused ordinary two-token batches.
 *  - the SAME caret twice is one string and one id.
 *  - a set of plain names carries no caret to alias with.
 *
 * What this flag deliberately does NOT cover is divergence 2, unresolvable
 * ticks: names (or dangling carets) that exist nowhere share ONE bucket on
 * chain and stay separate here. That one is undetectable from strings for
 * names, so flagging only its caret half would be arbitrary rather than
 * conservative. It is declared in the header instead, and vector-pinned.
 */
function maxMintsPerDistinctTick(ticks) {
    const counts = new Map();
    let max = 0;
    let carets = 0;
    let plain = 0;
    for (const tick of ticks) {
        const { key, aliasable } = mintTickKey(tick);
        if (!counts.has(key)) {
            if (aliasable) carets++; else plain++;
        }
        const count = (counts.get(key) || 0) + 1;
        counts.set(key, count);
        if (count > max) max = count;
    }
    return { max, approximate: carets > 0 && plain > 0 };
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
 * Returns { count, counts, mint, violation }:
 *   count      total commands, the raw ';'-split length with empties counted
 *   counts     classification key -> occurrences (every entry, parsed or not)
 *   mint       { max, approximate } from maxMintsPerDistinctTick over this
 *              batch's MINT TICKs; `approximate` means the MINT verdict rests
 *              on a caret alias only an indexer could resolve
 *   violation  null, or the FIRST rule broken in the arbiter's own order:
 *              the command cap, then an unknown ACTION, then a per-ACTION cap
 *
 * MINT is compared against the per-DISTINCT-token maximum rather than the raw
 * occurrence count (D7), exactly as the arbiter substitutes it.
 *
 * `mint.approximate` does NOT suppress a violation, and the asymmetry is the
 * whole reason it is safe not to. Keying on literal strings can only SPLIT
 * what the arbiter would merge - a caret and a name may be one token, never
 * two - so this maximum is a LOWER BOUND on the arbiter's. A maximum above
 * the cap is therefore CERTAIN and gets reported; only the ABSENCE of one is
 * in doubt, and that is exactly what the flag tells the caller. Suppressing
 * on the flag instead let one unrelated caret silence a violation two
 * identical plain ticks had already proved.
 */
function scanBatch(tail) {
    const entries = String(tail).split(';');
    const count = entries.length;
    const noMint = { max: 0, approximate: false };

    // The cap runs first, which pins error precedence: a batch that breaks it
    // and other rules reports the cap, never the rule a later loop would find.
    if (count > BATCH_COMMAND_LIMIT)
        return {
            count,
            counts: {},
            mint: noMint,
            violation: { kind: 'COMMAND_LIMIT', action: 'COMMAND', limit: BATCH_COMMAND_LIMIT, count },
        };

    const counts = {};
    // Collected in the SAME pass that counts, so the two can never disagree
    // about which entries are MINTs.
    const mintTicks = [];
    for (const entry of entries) {
        const key = classifyCommand(entry);
        counts[key] = (counts[key] || 0) + 1;
        if (key === 'MINT') mintTicks.push(commandTick(entry));
    }
    const mint = mintTicks.length ? maxMintsPerDistinctTick(mintTicks) : noMint;

    for (const entry of entries) {
        const name = String(entry).split('|')[0];
        if (!isKnownAction(name))
            return { count, counts, mint, violation: { kind: 'ACTION_UNKNOWN', action: name } };
    }

    for (const key of Object.keys(counts)) {
        const limit = BATCH_ACTION_LIMITS_ACTIVE[key];
        if (limit === undefined) continue;
        const observed = key === 'MINT' ? mint.max : counts[key];
        if (observed > limit)
            return { count, counts, mint, violation: { kind: 'ACTION_LIMIT', action: key, limit, count: observed } };
    }

    return { count, counts, mint, violation: null };
}

module.exports = {
    BATCH_COMMAND_LIMIT,
    BATCH_ACTION_LIMITS,
    BATCH_GATED_ACTION_LIMITS,
    BATCH_ACTION_LIMITS_ACTIVE,
    CHILD_ISSUE_KEY,
    UNRESOLVED_TICK_KEY,
    LEGACY_FORMAT_ACTIONS,
    isLegacyActionFormat,
    expandAlias,
    isKnownAction,
    classifyIssueTick,
    classifyCommand,
    commandTick,
    mintTickKey,
    maxMintsPerDistinctTick,
    paramsTick,
    scanBatch,
};
