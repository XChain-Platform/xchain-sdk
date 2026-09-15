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
 * Also carries the COMPOSITION half of a related, narrower rule (spec row
 * 31): inside a batch, a COINPAY obligation resolves its payment output by
 * FIRST MATCH on the payee address (xchain-indexer/src/actions/coinpay.js
 * findPaymentOutput), so a batch settling two obligations to one seller
 * must pay that seller ONE combined output, not two. `planCoinpayOutputs`
 * and `checkCoinpayOutputPlan` in batch_limits/coinpay_output_plan.js state
 * that rule as pure, testable units, in the same shape as the rest of this
 * module.
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
 * BATCH_ISSUANCE_LIMITS was UNARMED on mainnet when this mirror was written,
 * so a batch it accepts under a loosened rule (a parent plus children, MINTs
 * of several distinct tokens) was rejected there. That cost EXPIRES at the
 * mainnet instant 2026-08-16T00:00:00Z (armed 2026-08-14, pre-launch): at and
 * above it the chain applies the same rule set this mirror always has, and
 * the divergence closes rather than needing a mirror change.
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
 *     caller to spell the TICK by name; `maxMintsPerDistinctTick`, which
 *     decodes rather than composes, reports it as `approximate` instead of
 *     inventing a verdict it cannot support.
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

// Keep the weight constants and their readers here: xchain-documentation's constant-claims
// test reads their `const` lines from this file as text. Keep mintTickKey here: the
// structure gate declares this path as the home of the SQL its comment quotes.
const {
    BATCH_ACTION_LIMITS,
    BATCH_GATED_ACTION_LIMITS,
    BATCH_ACTION_LIMITS_ACTIVE,
    UNRESOLVED_TICK_KEY,
    CHILD_ISSUE_KEY,
    LEGACY_FORMAT_ACTIONS,
    isLegacyActionFormat,
    expandAlias,
} = require('./batch_limits/limit_tables.js');
const { classifyIssueTick, formatVersion, classifyCommand } = require('./batch_limits/command_classification.js');
const { commandTick, limitKeysInListOrder, paramsTick } = require('./batch_limits/tick_limits.js');
const { planCoinpayOutputs, checkCoinpayOutputPlan } = require('./batch_limits/coinpay_output_plan.js');

// Global per-BATCH command cap (indexer batch.js `commandLimit`).
const BATCH_COMMAND_LIMIT = 250;

// Budget the weighted sum is compared against at/after BATCH_COST_WEIGHTING
// (indexer batch.js `weightBudget`). Equal to the command cap on purpose: with
// a default weight of 1 an ordinary batch is decided arithmetically identically
// to the count rule, including the error string, which stays
// `invalid: COMMAND (limit)` for a weight overflow too.
const BATCH_WEIGHT_BUDGET = 250;

// Per-action COST WEIGHTS, byte-equal to the indexer's `commandWeights`. An
// action absent here weighs the default 1.
//
// The two classes are here for different reasons and both are the arbiter's,
// not ours: AIRDROP and DIVIDEND write a row PER RECIPIENT, and take a FLAT 25
// rather than `1 + recipients` because the recipient count is not on the wire;
// DEPLOY, EXECUTE and XEXEC run contract code, and 30 is the smallest round
// weight keeping a full VM batch under the 250 ordinary-equivalent bound.
//
// A chunk-carrier DEPLOY (format 4) is DISCOUNTED to the default 1, and the
// discount lives beside the table in `subCommandWeight` on BOTH sides rather
// than in either table, so the tables stay byte-equal with no carve-outs. The
// arbiter short-circuits a format-4 DEPLOY into chunk storage before the VM
// path ever runs, so it really is a row write; 30 would charge constructor
// cost for work that has none. The format byte is read with the arbiter's own
// derivation (`formatVersion`, in batch_limits/command_classification.js), and
// only off the WIRE STRING: the compose-side `actionWeight` sees a queued NAME
// with no serialized format yet, so it keeps DEPLOY's full 30 there, which is
// the arbiter's own fallback direction (unparseable falls through to the full
// weight).
//
// THE INVARIANT, mirrored from the arbiter: every weight is an integer >= 1.
// That is what makes the cheap count check a sound pre-filter for the weighted
// one (count > budget implies weight sum > budget), which is why callers may
// keep checking the count first and weigh only what survives.
const BATCH_COMMAND_WEIGHTS = Object.freeze({
    AIRDROP:  25,
    DIVIDEND: 25,
    DEPLOY:   30,
    EXECUTE:  30,
    XEXEC:    30,
});

/*
 * Cost weight of ONE raw sub-command string (indexer `subCommandWeight`).
 *
 * The action is derived exactly as `classifyCommand` derives it, and then
 * deliberately NOT reclassified: the arbiter weighs off `normalizeSubAction`,
 * whose only transformation is alias expansion, so a child ISSUE weighs the
 * same as any other ISSUE even though the per-action cap exempts it. Weighing
 * a child at 0 here would be the one thing the invariant forbids.
 *
 * Chunk-carrier DEPLOY (format 4) runs no constructor, so it takes the default
 * row-write weight rather than DEPLOY's VM weight, exactly as the arbiter
 * discounts it. The format byte comes from `formatVersion` over params[0]
 * (DEPLOY takes no legacy VERSION injection, so params[0] is always the
 * explicit version field), and anything unparseable falls through to the full
 * weight, which is the safe (over-charging) direction.
 *
 * Never throws, and falls back to 1 for the arbiter's reason: 1 is the
 * pre-flag behaviour for a sub-command, so an unreadable entry is charged as
 * an ordinary one rather than being made free.
 */
function subCommandWeight(command) {
    try {
        const action = expandAlias(String(command).split('|')[0]);
        if (action === 'DEPLOY' && formatVersion(String(command).split('|')[1]) === 4)
            return 1;
        return actionWeight(action);
    } catch (e) {
        return 1;
    }
}

/*
 * Cost weight of ONE action NAME (indexer `subCommandWeight`, whose body reads
 * the table off the already-normalized action and nothing else).
 *
 * Split out of the string form because the COMPOSE side has no wire string to
 * split: batchBuilder queues `{ action, params }` objects and serializes only
 * at build time, so it would otherwise have had to read the table itself, and a
 * second reader is how the weight table would come to be applied two ways. The
 * alias expansion and the >= 1 integer invariant are therefore stated once,
 * here, and both callers inherit them.
 *
 * Alias expansion is not decoration on this side either: `DROP` weighs 25
 * because it IS an AIRDROP to the arbiter, and a compose site that missed that
 * would sell 250 fan-outs for the price of 250 sends.
 *
 * Never throws, and falls back to 1 for the arbiter's reason: 1 is the pre-flag
 * behaviour for a sub-command, so an unreadable name is charged as an ordinary
 * one rather than being made free.
 */
function actionWeight(action) {
    try {
        const weight = BATCH_COMMAND_WEIGHTS[expandAlias(String(action))];
        if (weight === undefined) return 1;
        return (Number.isInteger(weight) && weight >= 1) ? weight : 1;
    } catch (e) {
        return 1;
    }
}

/*
 * Total cost weight of a BATCH's raw sub-command list (indexer `batchWeight`).
 *
 * Plain integer arithmetic, matching the arbiter: these are small counts, not
 * token amounts, so the bc* helpers this module uses for balances do not apply.
 */
function batchWeight(commands) {
    let total = 0;
    for (const command of commands) total += subCommandWeight(command);
    return total;
}

/*
 * Distinctness key for ONE MINT TICK, client-side.
 *
 * The arbiter keys on the RESOLVED ticker id; this keys on the CASE-FOLDED
 * string, which is exact for plain names (a folded name maps 1:1 to an id)
 * and inexact for the two cases the header declares. Returns
 * { key, aliasable }: `aliasable` marks a caret TICK, the divergence a
 * client CAN see, so compose-side callers can refuse the shape rather than
 * guess at it.
 *
 * The fold reproduces the arbiter's bucket rather than approximating it:
 * ticker ids resolve through `SELECT id FROM index_tickers WHERE LOWER(tick)=?`
 * (xchain-indexer/src/db/index_tables.js getTickerId, whose intern cache is keyed the same
 * way), and interning goes through that same resolve before it inserts, so two
 * names differing only by case can never BE two ids. Keying on the literal
 * string instead split a pair the chain merges, and a batch minting `JDOG` and
 * `jdog` passed compose-time validation and was rejected whole on chain with
 * the fees already spent. TICKs are mixed-case-legal on the wire (validator.js
 * TICK_REGEX), so this is an everyday shape, not an exotic one.
 */
function mintTickKey(tick) {
    const t = (tick === undefined || tick === null) ? '' : String(tick).trim();
    // '' is the arbiter's own unresolvable case (it never probes an empty
    // tick), so the mirror can reproduce that bucket exactly.
    if (t === '') return { key: UNRESOLVED_TICK_KEY, aliasable: false };
    // A caret TICK is '^' + a decimal id: case-free, so the fold is a no-op
    // there and the two forms stay comparable as written.
    if (t.charAt(0) === '^') return { key: t, aliasable: true };
    return { key: t.toLowerCase(), aliasable: false };
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

module.exports = {
    BATCH_COMMAND_LIMIT,
    BATCH_WEIGHT_BUDGET,
    BATCH_COMMAND_WEIGHTS,
    actionWeight,
    formatVersion,
    subCommandWeight,
    batchWeight,
    BATCH_ACTION_LIMITS,
    BATCH_GATED_ACTION_LIMITS,
    BATCH_ACTION_LIMITS_ACTIVE,
    CHILD_ISSUE_KEY,
    UNRESOLVED_TICK_KEY,
    LEGACY_FORMAT_ACTIONS,
    isLegacyActionFormat,
    expandAlias,
    classifyIssueTick,
    classifyCommand,
    limitKeysInListOrder,
    commandTick,
    mintTickKey,
    maxMintsPerDistinctTick,
    paramsTick,
    planCoinpayOutputs,
    checkCoinpayOutputPlan,
};
