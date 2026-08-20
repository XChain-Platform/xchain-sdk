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
 * and `checkCoinpayOutputPlan` near the bottom of this file state that rule
 * as pure, testable units, in the same shape as everything above.
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
const mathjs = require('mathjs');

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

// Whether this (alias-expanded) name is one a client can author. It stands in for
// the indexer's `protocolChanges.isEnabled(action)` activation scan - an
// unregistered name, including the empty string an empty command yields, is
// `invalid: ACTION (unknown)` there, whole-batch, before any limit is counted -
// and it is deliberately NARROWER than that scan, so read it as encodability, not
// as the chain's registry. The registry recognizes every name it holds an entry
// for, which is a superset of the encodable formats: the validator/lifecycle/
// mirror-injected actions absent from formats.js by design (DISPENSE,
// COINPAY_EXPIRE, SLASH, ATTEST, ANCHOR, XCALL, NODEPROOF) and every feature-flag
// entry sharing the same table. A hand-built wire batch naming one of those reads
// ACTION_UNKNOWN here while the arbiter's scan passes it to its handler.
//
// The divergence is one-way by construction, and in the safe direction: all 31
// formats keys are registered with no activation gate, so this never calls known
// a name the chain would reject. It over-warns about a batch nothing in this SDK
// can compose; it never vouches for one the chain refuses.
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
/*
 * Cost weight of ONE raw sub-command string (indexer `subCommandWeight`).
 *
 * The action is derived exactly as `classifyCommand` derives it, and then
 * deliberately NOT reclassified: the arbiter weighs off `normalizeSubAction`,
 * whose only transformation is alias expansion, so a child ISSUE weighs the
 * same as any other ISSUE even though the per-action cap exempts it. Weighing
 * a child at 0 here would be the one thing the invariant forbids.
 *
 * Never throws, and falls back to 1 for the arbiter's reason: 1 is the
 * pre-flag behaviour for a sub-command, so an unreadable entry is charged as
 * an ordinary one rather than being made free.
 */
function subCommandWeight(command) {
    try {
        return actionWeight(String(command).split('|')[0]);
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
 * The DISTINCT classification keys of a command list, in the order each one's
 * FIRST command appears.
 *
 * This is the ONE expression of spec R2b for the client side: among per-ACTION
 * caps, the error names the action whose first sub-command appears EARLIEST in
 * the batch's command list. Both cap loops in this SDK (scanBatch below and
 * decoder/parse.js) walk this list, and the arbiter walks its own list-driven
 * copy, so the three agree by rule instead of by coincidence.
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

    // First-appearance order, DECLARED by spec R2b rather than inherited from
    // key insertion: see limitKeysInListOrder.
    for (const key of limitKeysInListOrder(entries)) {
        const limit = BATCH_ACTION_LIMITS_ACTIVE[key];
        if (limit === undefined) continue;
        const observed = key === 'MINT' ? mint.max : counts[key];
        if (observed > limit)
            return { count, counts, mint, violation: { kind: 'ACTION_LIMIT', action: key, limit, count: observed } };
    }

    return { count, counts, mint, violation: null };
}

/*
 * Per-payee COINPAY payment-output planning (spec row 31).
 *
 * Inside a batch, each COINPAY obligation resolves its own payment output by FIRST
 * MATCH on the payee address over the batch's vout-sorted output set
 * (xchain-indexer/src/actions/coinpay.js `findPaymentOutput`), and the consumed-value
 * ledger then draws down THAT one output for every obligation owed to the same payee
 * (`coinPayeeConsumed`). So an obligation to a payee who is ALSO paid by a second,
 * later output can never reach that second output: only the first-matching one is ever
 * read, no matter how many obligations remain unsettled. A composer settling two
 * obligations to the same seller in one batch must therefore combine both amounts into
 * ONE output for that payee, never split them across two.
 *
 * This applies only on the BATCHED path, and only once BOTH gates the behaviour
 * depends on are armed: `BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION` (decoder, so a
 * batched COINPAY's payment output reaches the indexer at all - genesis-active on
 * testnet/regtest, mainnet at 2026-08-16T00:00:00Z) and `BATCH_ISSUANCE_LIMITS`
 * (indexer, so the per-payee resolution below ever runs - mainnet at the SAME instant).
 * Both were armed together on 2026-08-14 precisely so no window exists where one is
 * live and the other is not. BELOW that instant a batched COINPAY settles nothing
 * regardless of the output plan (row 21), so this planner's rule has no live consensus
 * consequence on mainnet history; at and above it, the rule is load-bearing and a
 * composer that ignores it loses a settlement.
 *
 * WHAT THIS CANNOT VERIFY FROM STRINGS ALONE: matching is exact string equality
 * between the `payee` / `address` you pass here and the address the FINISHED
 * transaction's output will actually carry, mirroring the indexer's own
 * `output.address === address` test with no normalization on either side. A payee
 * address written two different but equivalent ways (case, an alternate valid
 * encoding) is two different pools here and on chain; this planner declares that
 * rather than attempting address canonicalization it has no chain context to perform
 * correctly, the same honesty `mintTickKey`'s caret declaration states above.
 */

/*
 * Derive the minimal per-payee output plan for a list of COINPAY obligations.
 *
 * obligations: [{ payee, amount }], amount a decimal string or number.
 * Returns: [{ payee, amount }], ONE entry per DISTINCT payee in first-appearance
 * order, amount the decimal-string SUM of every obligation owed to that payee.
 *
 * This is the shape a composer should build payment outputs from: one output per
 * returned entry. Distinct payees' outputs may land at any relative vout (matching is
 * per-address, not per-position); it is entries for the SAME payee that must never be
 * split across two outputs.
 */
function planCoinpayOutputs(obligations) {
    const order = [];
    const totals = new Map();
    for (const obligation of (obligations || [])) {
        if (!obligation || obligation.payee === undefined || obligation.payee === null) continue;
        const payee = String(obligation.payee);
        const amount = (obligation.amount === undefined || obligation.amount === null) ? '0' : obligation.amount;
        if (!totals.has(payee)) {
            totals.set(payee, mathjs.bignumber(0));
            order.push(payee);
        }
        totals.set(payee, mathjs.add(totals.get(payee), mathjs.bignumber(String(amount))));
    }
    return order.map(payee => ({
        payee,
        amount: mathjs.format(totals.get(payee), { notation: 'fixed' }),
    }));
}

/*
 * Check a PLANNED output set against a list of obligations, resolving each one exactly
 * as the arbiter does: the output that settles an obligation is the FIRST entry in
 * `outputs` (array order stands in for vout order) whose address equals the
 * obligation's payee, and every obligation naming that SAME payee draws on that SAME
 * output (owed amounts summed; surplus above the total owed stays in the pool - R5b).
 *
 * obligations: [{ payee, amount }]
 * outputs:     [{ address, amount }], in the order they will appear as outputs
 *              (lowest vout first)
 *
 * Returns { ok, violations }. `violations` is a list of
 * { payee, owed, available, reason }, `reason` one of:
 *   'NO_OUTPUT'    no output in the set pays this payee at all
 *   'INSUFFICIENT' the first matching output's amount is less than the SUM owed to
 *                  this payee across every obligation naming it
 *
 * A payee paid by two or more outputs in `outputs` is not itself flagged as a shape
 * error (extra outputs to an already-settled payee are simply invisible to
 * settlement, not rejected); it is comparing owed amounts against only the FIRST
 * match that surfaces the composition mistake this function exists to catch -
 * splitting one payee's combined amount across two outputs reads here as
 * INSUFFICIENT against the first (smaller) one, exactly as it would on chain.
 */
function checkCoinpayOutputPlan(obligations, outputs) {
    const list = Array.isArray(outputs) ? outputs : [];
    const owed = new Map();
    const order = [];
    for (const obligation of (obligations || [])) {
        if (!obligation || obligation.payee === undefined || obligation.payee === null) continue;
        const payee = String(obligation.payee);
        const amount = (obligation.amount === undefined || obligation.amount === null) ? '0' : obligation.amount;
        if (!owed.has(payee)) {
            owed.set(payee, mathjs.bignumber(0));
            order.push(payee);
        }
        owed.set(payee, mathjs.add(owed.get(payee), mathjs.bignumber(String(amount))));
    }

    const violations = [];
    for (const payee of order) {
        // FIRST match only, identical to xchain-indexer/src/actions/coinpay.js
        // findPaymentOutput: a second output paying the same address is never read.
        const output = list.find(entry => entry && String(entry.address) === payee);
        const total = owed.get(payee);
        if (!output) {
            violations.push({
                payee,
                owed: mathjs.format(total, { notation: 'fixed' }),
                available: '0',
                reason: 'NO_OUTPUT',
            });
            continue;
        }
        const rawAvailable = (output.amount === undefined || output.amount === null) ? '0' : output.amount;
        const available = mathjs.bignumber(String(rawAvailable));
        if (mathjs.smaller(available, total)) {
            violations.push({
                payee,
                owed: mathjs.format(total, { notation: 'fixed' }),
                available: mathjs.format(available, { notation: 'fixed' }),
                reason: 'INSUFFICIENT',
            });
        }
    }
    return { ok: violations.length === 0, violations };
}

module.exports = {
    BATCH_COMMAND_LIMIT,
    BATCH_WEIGHT_BUDGET,
    BATCH_COMMAND_WEIGHTS,
    actionWeight,
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
    isKnownAction,
    classifyIssueTick,
    classifyCommand,
    limitKeysInListOrder,
    commandTick,
    mintTickKey,
    maxMintsPerDistinctTick,
    paramsTick,
    scanBatch,
    planCoinpayOutputs,
    checkCoinpayOutputPlan,
};
