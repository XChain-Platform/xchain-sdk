'use strict';

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 **********************************************************************
 * BATCH limit-scan conformance: SDK mirror vs the consensus arbiter.
 *
 * ONE vector set, compared by CLASSIFICATION and COUNT rather than by the
 * frozen limits table. The table was the whole guard before, and it could not
 * see the two real divergences: the mirror counted only the sub-entries that
 * PARSED where the arbiter counts every command, and an empty entry was a
 * per-command failure here and a whole-batch reject there.
 *
 * Each vector states the classification of every sub-command, the command
 * count, and the whole-batch verdict. The SDK half runs everywhere. When a
 * sibling xchain-indexer checkout is present the SAME table is driven through
 * the REAL arbiter - classifyLimitAction for the classifications,
 * Batch.parse() for the verdict, maxMintsPerDistinctTick for the per-token
 * MINT maximum, and the number of dispatched sub-commands for the count - so
 * this is a comparison against running code, not against a transcription of it.
 *
 * WHERE THE TWO HALVES DO NOT AGREE, THE VECTOR SAYS SO OUT LOUD.
 *
 * D7 keys MINT distinctness on the RESOLVED TICKER ID; the client mirror holds
 * strings and is a DECLARED conservative approximation (see the header of
 * src/batchLimits.js). A vector that straddles one of those two declared
 * divergences carries `arbiterVerdict` and `sdkVerdict` SEPARATELY plus a
 * `divergence` naming which one it pins - never a single verdict massaged
 * until both halves agree, which is how a divergence gets discovered in
 * production instead of here. A meta-test enforces that shape: a vector may
 * state two verdicts ONLY if it names a declared divergence, so a future edit
 * cannot quietly split a vector's expectations to make a failure go away.
 ********************************************************************/

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const {
    BATCH_COMMAND_LIMIT,
    BATCH_WEIGHT_BUDGET,
    BATCH_COMMAND_WEIGHTS,
    BATCH_ACTION_LIMITS,
    BATCH_GATED_ACTION_LIMITS,
    BATCH_ACTION_LIMITS_ACTIVE,
    CHILD_ISSUE_KEY,
    UNRESOLVED_TICK_KEY,
    classifyCommand,
    formatVersion,
    limitKeysInListOrder,
    maxMintsPerDistinctTick,
    mintTickKey,
    scanBatch,
    subCommandWeight,
    batchWeight,
} = require('../../src/batchLimits.js');

// The arbiter's error vocabulary, so one table can state one expected verdict
// for both halves. 'valid' means no whole-batch rule was broken.
function verdictOf(scan) {
    const v = scan.violation;
    if (!v) return 'valid';
    if (v.kind === 'COMMAND_LIMIT') return 'invalid: COMMAND (limit)';
    // The weight budget rejects with the SAME string as the count cap: the
    // arbiter's error is "this batch is too much work", only measured better.
    if (v.kind === 'WEIGHT_LIMIT') return 'invalid: COMMAND (limit)';
    if (v.kind === 'ACTION_UNKNOWN') return 'invalid: ACTION (unknown)';
    return 'invalid: ' + v.action + ' (limit)';
}

const repeat = (n, f) => Array.from({ length: n }, (_, i) => f(i));

/*
 * The two divergences src/batchLimits.js DECLARES in its header. A vector may
 * state a different verdict per half only by naming one of these.
 */
const CARET_ALIAS = 'caret alias (declared divergence 1: detectable, flagged approximate)';
const UNRESOLVABLE = 'unresolvable tick (declared divergence 2: undetectable client-side)';
const DECLARED_DIVERGENCES = [CARET_ALIAS, UNRESOLVABLE];

/*
 * Ticker names the arbiter half's stub database knows about, and the ids they
 * resolve to. These are load-bearing, not decoration: D7 buckets MINTs by
 * RESOLVED ID, so a stub that answers every lookup with one id collapses every
 * MINT into a single bucket and makes the distinctness vectors pass without
 * testing anything (that is exactly what `getTickerId: async () => 1` did
 * here, and it is why the old 'MINT keeps its limit of 1' vector looked green).
 *
 * JDOG is spelled 614 on purpose: the caret-alias vectors need a name and a
 * `^<id>` that really are ONE token.
 */
const TICKER_IDS = new Map([
    ['jdog',  614],
    ['other', 615],
    ['pepe',  700],
    ['doge',  701],
]);
const EXISTING_TICKER_IDS = new Set(TICKER_IDS.values());

/*
 * The vector set. `classes` is asserted per sub-command; where a vector is 250
 * commands long the classification is uniform and stated once via `uniform`.
 *
 * MINT vectors additionally state `mintMax` (the mirror's per-token maximum)
 * and `arbiterMintMax` (the arbiter's, over RESOLVED ids). Those two numbers
 * differing IS the divergence, stated as a number rather than inferred from a
 * verdict. `approximate` is asserted on EVERY vector, present or not, so the
 * flag cannot quietly stop being set.
 */
const VECTORS = [
    {
        name: 'undotted TICK is the one top-level slot',
        tail: 'ISSUE|0|JDOG|1000',
        classes: ['ISSUE'], count: 1, verdict: 'valid',
    },
    {
        name: 'dotted child TICK is exempt: parent plus children in one batch',
        tail: 'ISSUE|0|JDOG|1000;ISSUE|0|JDOG.1|1;ISSUE|0|JDOG.2|1',
        classes: ['ISSUE', CHILD_ISSUE_KEY, CHILD_ISSUE_KEY], count: 3, verdict: 'valid',
    },
    {
        name: 'deep-dotted child TICK is exempt too',
        tail: 'ISSUE|0|JDOG.1.2|1;ISSUE|0|JDOG.3.4|1',
        classes: [CHILD_ISSUE_KEY, CHILD_ISSUE_KEY], count: 2, verdict: 'valid',
    },
    {
        name: 'two undotted ISSUEs break the top-level limit',
        tail: 'ISSUE|0|JDOG|1000;ISSUE|0|OTHER|1',
        classes: ['ISSUE', 'ISSUE'], count: 2, verdict: 'invalid: ISSUE (limit)',
    },
    {
        name: 'caret TICK is never exempt (plain)',
        tail: 'ISSUE|0|^12|1;ISSUE|0|^13|1',
        classes: ['ISSUE', 'ISSUE'], count: 2, verdict: 'invalid: ISSUE (limit)',
    },
    {
        name: 'caret TICK is never exempt (dotted: the dot is an id separator)',
        tail: 'ISSUE|0|^12.5|1;ISSUE|0|^13.6|1',
        classes: ['ISSUE', 'ISSUE'], count: 2, verdict: 'invalid: ISSUE (limit)',
    },
    {
        name: 'legacy no-VERSION dotted TICK classifies as a child after the implied VERSION 0',
        tail: 'ISSUE|JDOG.1|1000;ISSUE|JDOG.2|1000;ISSUE|JDOG|1',
        classes: [CHILD_ISSUE_KEY, CHILD_ISSUE_KEY, 'ISSUE'], count: 3, verdict: 'valid',
    },
    {
        name: 'unknown FORMAT still classifies off params[1]',
        tail: 'ISSUE|99|JDOG.1|1;ISSUE|99|JDOG.2|1',
        classes: [CHILD_ISSUE_KEY, CHILD_ISSUE_KEY], count: 2, verdict: 'valid',
    },
    {
        name: 'malformed ISSUE with no TICK counts as top-level',
        tail: 'ISSUE|0;ISSUE|0|JDOG|1',
        classes: ['ISSUE', 'ISSUE'], count: 2, verdict: 'invalid: ISSUE (limit)',
    },
    {
        name: 'an empty entry is a whole-batch reject, not a per-command failure',
        tail: 'ISSUE|0|JDOG|1;;ISSUE|0|JDOG.1|1',
        classes: ['ISSUE', '', CHILD_ISSUE_KEY], count: 3, verdict: 'invalid: ACTION (unknown)',
    },
    {
        name: 'a trailing semicolon is a command and it is empty',
        tail: 'ISSUE|0|JDOG|1;',
        classes: ['ISSUE', ''], count: 2, verdict: 'invalid: ACTION (unknown)',
    },
    {
        name: 'a LOWERCASE action name is unknown, never a second ISSUE',
        tail: 'issue|0|A;issue|0|B',
        classes: ['issue', 'issue'], count: 2, verdict: 'invalid: ACTION (unknown)',
    },
    {
        name: 'aliases expand before classification',
        tail: 'TRANSFER|0|JDOG|1|addr;ISSUE|0|JDOG.1|1',
        classes: ['SEND', CHILD_ISSUE_KEY], count: 2, verdict: 'valid',
    },

    /* ---- D5: DEPLOY, capped at 1 by the GATED table ------------------- */
    {
        name: 'exactly one DEPLOY is within the gated cap',
        tail: 'DEPLOY|0|600160005260206000f3',
        classes: ['DEPLOY'], count: 1, verdict: 'valid',
    },
    {
        name: 'two DEPLOYs break the gated cap of 1',
        tail: 'DEPLOY|0|600160005260206000f3;DEPLOY|0|600260005260206000f3',
        classes: ['DEPLOY', 'DEPLOY'], count: 2, verdict: 'invalid: DEPLOY (limit)',
    },
    {
        name: 'a DEPLOY rides alongside the other actions it does not cap',
        tail: 'DEPLOY|0|600160005260206000f3;ISSUE|0|JDOG|1000;ISSUE|0|JDOG.1|1;MINT|0|PEPE|1',
        classes: ['DEPLOY', 'ISSUE', CHILD_ISSUE_KEY, 'MINT'], count: 4, verdict: 'valid',
        mintMax: 1, arbiterMintMax: 1,
    },

    /* ---- R2b: per-ACTION error precedence, DECLARED ------------------- *
     *
     * Among per-ACTION caps, the error names the action whose FIRST
     * sub-command appears EARLIEST in the command list (spec R2b). That string
     * is consensus, so this block is a rule test, not a tidiness test: every
     * vector below is stated in BOTH directions, because a single direction
     * can be satisfied by an accident (alphabetical order, key insertion,
     * count order) rather than by the rule.
     *
     * The pairs are chosen so that each plausible WRONG tie-break loses at
     * least once:
     *   alphabetical  - loses on ISSUE-before-DEPLOY and MINT-before-DEPLOY
     *   by count      - loses on 'two ISSUEs, then THREE DEPLOYs'
     *   last-seen     - loses on every pair
     *   key insertion - loses on nothing today, which is exactly the accident
     *                   R2b exists to replace with a rule.
     */
    {
        name: 'two broken per-action caps: the action seen FIRST names the error (DEPLOY)',
        tail: 'DEPLOY|0|6001;DEPLOY|0|6002;ISSUE|0|AAA|1;ISSUE|0|BBB|1',
        classes: ['DEPLOY', 'DEPLOY', 'ISSUE', 'ISSUE'], count: 4,
        verdict: 'invalid: DEPLOY (limit)',
    },
    {
        name: 'two broken per-action caps, other order: the action seen FIRST names the error (ISSUE)',
        tail: 'ISSUE|0|AAA|1;ISSUE|0|BBB|1;DEPLOY|0|6001;DEPLOY|0|6002',
        classes: ['ISSUE', 'ISSUE', 'DEPLOY', 'DEPLOY'], count: 4,
        verdict: 'invalid: ISSUE (limit)',
    },
    {
        // INTERLEAVED, so no implementation can pass by looking at which cap
        // was COMPLETED first: DEPLOY's second command is last in the list and
        // it still names the error, because its FIRST one leads.
        name: 'precedence is FIRST APPEARANCE, not first cap completed (DEPLOY leads)',
        tail: 'DEPLOY|0|6001;ISSUE|0|AAA|1;ISSUE|0|BBB|1;DEPLOY|0|6002',
        classes: ['DEPLOY', 'ISSUE', 'ISSUE', 'DEPLOY'], count: 4,
        verdict: 'invalid: DEPLOY (limit)',
    },
    {
        name: 'precedence is FIRST APPEARANCE, not first cap completed (ISSUE leads)',
        tail: 'ISSUE|0|AAA|1;DEPLOY|0|6001;DEPLOY|0|6002;ISSUE|0|BBB|1',
        classes: ['ISSUE', 'DEPLOY', 'DEPLOY', 'ISSUE'], count: 4,
        verdict: 'invalid: ISSUE (limit)',
    },
    {
        // Breaks a count-ordered tie-break: DEPLOY exceeds its cap by more,
        // and ISSUE still names the error because it appears first.
        name: 'the LEADING action names the error even when the other breaks its cap by more',
        tail: 'ISSUE|0|AAA|1;ISSUE|0|BBB|1;DEPLOY|0|6001;DEPLOY|0|6002;DEPLOY|0|6003',
        classes: ['ISSUE', 'ISSUE', 'DEPLOY', 'DEPLOY', 'DEPLOY'], count: 5,
        verdict: 'invalid: ISSUE (limit)',
    },
    {
        name: 'the LEADING action names the error even when it breaks its cap by less',
        tail: 'DEPLOY|0|6001;DEPLOY|0|6002;DEPLOY|0|6003;ISSUE|0|AAA|1;ISSUE|0|BBB|1',
        classes: ['DEPLOY', 'DEPLOY', 'DEPLOY', 'ISSUE', 'ISSUE'], count: 5,
        verdict: 'invalid: DEPLOY (limit)',
    },
    {
        // MINT is the one cap compared against a SUBSTITUTED count (D7's
        // per-distinct-token maximum), so it has to be pinned in the ordering
        // too: the substitution must not move where MINT sits in the queue.
        name: 'MINT takes its turn by first appearance like any other cap (MINT leads)',
        tail: 'MINT|0|PEPE|1;MINT|0|PEPE|2;ISSUE|0|AAA|1;ISSUE|0|BBB|1',
        classes: ['MINT', 'MINT', 'ISSUE', 'ISSUE'], count: 4,
        verdict: 'invalid: MINT (limit)',
        mintMax: 2, arbiterMintMax: 2,
    },
    {
        name: 'MINT takes its turn by first appearance like any other cap (ISSUE leads)',
        tail: 'ISSUE|0|AAA|1;ISSUE|0|BBB|1;MINT|0|PEPE|1;MINT|0|PEPE|2',
        classes: ['ISSUE', 'ISSUE', 'MINT', 'MINT'], count: 4,
        verdict: 'invalid: ISSUE (limit)',
        mintMax: 2, arbiterMintMax: 2,
    },
    {
        // MINT before DEPLOY is the vector alphabetical order gets wrong.
        name: 'a leading MINT outranks a later DEPLOY, which alphabetical order would reverse',
        tail: 'MINT|0|PEPE|1;MINT|0|PEPE|2;DEPLOY|0|6001;DEPLOY|0|6002',
        classes: ['MINT', 'MINT', 'DEPLOY', 'DEPLOY'], count: 4,
        verdict: 'invalid: MINT (limit)',
        mintMax: 2, arbiterMintMax: 2,
    },
    {
        name: 'a leading DEPLOY outranks a later MINT',
        tail: 'DEPLOY|0|6001;DEPLOY|0|6002;MINT|0|PEPE|1;MINT|0|PEPE|2',
        classes: ['DEPLOY', 'DEPLOY', 'MINT', 'MINT'], count: 4,
        verdict: 'invalid: DEPLOY (limit)',
        mintMax: 2, arbiterMintMax: 2,
    },
    {
        // BATCH's cap is 0, so ONE nested batch already breaks it. It is the
        // alphabetically first name of the four, which is what makes the
        // ISSUE-leads direction worth stating.
        name: 'a leading nested BATCH names the error over a later ISSUE break',
        tail: 'BATCH|0|ISSUE|0|X|1;ISSUE|0|AAA|1;ISSUE|0|BBB|1',
        classes: ['BATCH', 'ISSUE', 'ISSUE'], count: 3,
        verdict: 'invalid: BATCH (limit)',
    },
    {
        name: 'a leading ISSUE break names the error over a later nested BATCH',
        tail: 'ISSUE|0|AAA|1;ISSUE|0|BBB|1;BATCH|0|ISSUE|0|X|1',
        classes: ['ISSUE', 'ISSUE', 'BATCH'], count: 3,
        verdict: 'invalid: ISSUE (limit)',
    },
    {
        // Uncapped and exempt commands take no turn: a leading SEND and a
        // leading child ISSUE must not shift which capped action is reported.
        name: 'uncapped and exempt commands do not take a turn in the precedence queue',
        tail: 'SEND|0|JDOG|1|mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH;ISSUE|0|JDOG.1|1;'
            + 'DEPLOY|0|6001;ISSUE|0|AAA|1;ISSUE|0|BBB|1;DEPLOY|0|6002',
        classes: ['SEND', CHILD_ISSUE_KEY, 'DEPLOY', 'ISSUE', 'ISSUE', 'DEPLOY'], count: 6,
        verdict: 'invalid: DEPLOY (limit)',
    },
    {
        // Three broken caps at once, both directions, so the rule is pinned as
        // an ORDERING rather than as a pairwise preference.
        name: 'three broken per-action caps: the leader still names the error (MINT)',
        tail: 'MINT|0|PEPE|1;MINT|0|PEPE|2;DEPLOY|0|6001;DEPLOY|0|6002;ISSUE|0|AAA|1;ISSUE|0|BBB|1',
        classes: ['MINT', 'MINT', 'DEPLOY', 'DEPLOY', 'ISSUE', 'ISSUE'], count: 6,
        verdict: 'invalid: MINT (limit)',
        mintMax: 2, arbiterMintMax: 2,
    },
    {
        name: 'three broken per-action caps, reversed: the leader still names the error (ISSUE)',
        tail: 'ISSUE|0|AAA|1;ISSUE|0|BBB|1;DEPLOY|0|6001;DEPLOY|0|6002;MINT|0|PEPE|1;MINT|0|PEPE|2',
        classes: ['ISSUE', 'ISSUE', 'DEPLOY', 'DEPLOY', 'MINT', 'MINT'], count: 6,
        verdict: 'invalid: ISSUE (limit)',
        mintMax: 2, arbiterMintMax: 2,
    },
    {
        // R2b is subordinate to what R2/F7 already pinned: an unknown ACTION
        // outranks every per-action cap however early the capped one appears.
        name: 'an unknown ACTION still outranks the leading per-action cap',
        tail: 'ISSUE|0|AAA|1;ISSUE|0|BBB|1;NOPE|0|x',
        classes: ['ISSUE', 'ISSUE', 'NOPE'], count: 3,
        verdict: 'invalid: ACTION (unknown)',
    },

    /* ---- D7: MINT, one per DISTINCT RESOLVED token -------------------- */
    {
        name: 'two MINTs of two DISTINCT existing ticks are valid (one per token, any number of tokens)',
        tail: 'MINT|0|PEPE|1;MINT|0|DOGE|1',
        classes: ['MINT', 'MINT'], count: 2, verdict: 'valid',
        mintMax: 1, arbiterMintMax: 1,
    },
    {
        name: 'two MINTs of ONE tick break the per-token limit',
        tail: 'MINT|0|PEPE|1;MINT|0|PEPE|1',
        classes: ['MINT', 'MINT'], count: 2, verdict: 'invalid: MINT (limit)',
        mintMax: 2, arbiterMintMax: 2,
    },
    {
        name: 'three MINTs over two ticks: the cap sees the MAXIMUM per token, not the total',
        tail: 'MINT|0|PEPE|1;MINT|0|DOGE|1;MINT|0|PEPE|1',
        classes: ['MINT', 'MINT', 'MINT'], count: 3, verdict: 'invalid: MINT (limit)',
        mintMax: 2, arbiterMintMax: 2,
    },
    {
        // MINT's TICK sits at params[1] only AFTER the implied VERSION 0 is
        // injected; an un-normalized read of this pair sees '1' and 'PEPE',
        // two buckets, and calls the batch valid. So this vector fails the
        // moment either side reads the TICK too early.
        name: 'legacy no-VERSION MINT: the TICK is read after the implied VERSION 0',
        tail: 'MINT|PEPE|1|mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH;MINT|0|PEPE|1',
        classes: ['MINT', 'MINT'], count: 2, verdict: 'invalid: MINT (limit)',
        mintMax: 2, arbiterMintMax: 2,
    },
    {
        name: 'two legacy no-VERSION MINTs of DIFFERENT ticks stay distinct',
        tail: 'MINT|PEPE|1|mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH;MINT|DOGE|1|mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
        classes: ['MINT', 'MINT'], count: 2, verdict: 'valid',
        mintMax: 1, arbiterMintMax: 1,
    },
    {
        // The mirror is EXACT here and must say so: one caret string is one
        // id, no resolution needed. If `approximate` fired on any caret in
        // sight it would suppress this real violation, so pinning the flag
        // false is what stops the approximation from swallowing the rule.
        name: 'two MINTs of the SAME caret TICK need no resolution and are exact',
        tail: 'MINT|0|^614|1;MINT|0|^614|1',
        classes: ['MINT', 'MINT'], count: 2, verdict: 'invalid: MINT (limit)',
        mintMax: 2, arbiterMintMax: 2,
    },
    {
        // Both halves agree on the VERDICT, and the mirror still reports that
        // it could not prove it: `approximate` is a statement about the
        // answer's provenance, never a verdict of its own.
        name: 'a name and a DANGLING caret are distinct to both halves, and the mirror still flags it',
        tail: 'MINT|0|JDOG|1;MINT|0|^999|1',
        classes: ['MINT', 'MINT'], count: 2, verdict: 'valid',
        mintMax: 1, arbiterMintMax: 1, approximate: true,
    },

    {
        // `approximate` must NOT be a mute button. Two plain PEPEs already prove
        // a violation on their own, and no resolution can UNDO it: keying on
        // literal strings only ever SPLITS what the arbiter would merge, so this
        // maximum is a lower bound and a lower bound above the cap is certain.
        // The unrelated caret still sets the flag - the flag reports doubt about
        // the ABSENCE of a violation, never about one already proved.
        name: 'an unrelated caret does not silence a violation two plain ticks already proved',
        tail: 'MINT|0|PEPE|1;MINT|0|PEPE|1;MINT|0|^614|1',
        classes: ['MINT', 'MINT', 'MINT'], count: 3, verdict: 'invalid: MINT (limit)',
        mintMax: 2, arbiterMintMax: 2, approximate: true,
    },

    /* ---- The two DELIBERATE divergences, stated per half --------------- */
    {
        // DIVERGENCE 1. `JDOG` and `^614` are ONE token to the arbiter and two
        // strings here, so the chain rejects a batch this mirror accepts. The
        // mirror does not guess: it raises no MINT violation off an answer it
        // cannot support and hands the caller `approximate` instead.
        name: 'caret alias: one token spelled two ways is one bucket on chain, two strings in the mirror',
        tail: 'MINT|0|JDOG|1;MINT|0|^614|1',
        classes: ['MINT', 'MINT'], count: 2,
        arbiterVerdict: 'invalid: MINT (limit)', sdkVerdict: 'valid',
        mintMax: 1, arbiterMintMax: 2, approximate: true,
        divergence: CARET_ALIAS,
    },
    {
        // DIVERGENCE 2. Neither name resolves, so the arbiter puts both in its
        // ONE unresolvable bucket and rejects. A client cannot know which
        // names exist without asking an indexer, so `approximate` is FALSE
        // here: the mirror is not merely unsure, it is unaware, and that is
        // the divergence it declares rather than closes.
        name: 'unresolvable ticks: two unknown names are one bucket on chain and invisible to the mirror',
        tail: 'MINT|0|NOSUCH|1;MINT|0|NEITHER|1',
        classes: ['MINT', 'MINT'], count: 2,
        arbiterVerdict: 'invalid: MINT (limit)', sdkVerdict: 'valid',
        mintMax: 1, arbiterMintMax: 2, approximate: false,
        divergence: UNRESOLVABLE,
    },

    /* ---- The 250-command cap ------------------------------------------ */
    {
        name: 'exactly 250 commands is within the cap',
        tail: repeat(250, (i) => 'ISSUE|0|JDOG.' + i + '|1').join(';'),
        uniform: CHILD_ISSUE_KEY, count: 250, verdict: 'valid',
    },
    {
        name: '251 commands rejects the whole batch',
        tail: repeat(251, (i) => 'ISSUE|0|JDOG.' + i + '|1').join(';'),
        uniform: CHILD_ISSUE_KEY, count: 251, verdict: 'invalid: COMMAND (limit)',
    },
    {
        name: '250 commands plus a trailing semicolon is 251 and over the cap',
        tail: repeat(250, (i) => 'ISSUE|0|JDOG.' + i + '|1').join(';') + ';',
        count: 251, verdict: 'invalid: COMMAND (limit)',
    },
    {
        name: 'the cap outranks the ISSUE limit when a batch breaks both',
        tail: repeat(251, (i) => 'ISSUE|0|T' + i + '|1').join(';'),
        uniform: 'ISSUE', count: 251, verdict: 'invalid: COMMAND (limit)',
    },
];

const arbiterVerdictOf = (v) => (v.arbiterVerdict !== undefined ? v.arbiterVerdict : v.verdict);
const sdkVerdictOf = (v) => (v.sdkVerdict !== undefined ? v.sdkVerdict : v.verdict);

/* ---- BATCH_COST_WEIGHTING conformance vectors -------------------------- *
 *
 * Weights are written out LONGHAND, never derived from BATCH_COMMAND_WEIGHTS:
 * deriving them here would make every expectation agree with the table by
 * construction, including a wrong table. Each vector is asserted against the
 * SDK mirror AND, when the sibling checkout is present, against the arbiter's
 * own subCommandWeight/batchWeight, so a drift on EITHER side reddens.
 */
const SEND_CMD    = 'SEND|0|JDOG|1|mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const EXEC_CMD    = 'EXECUTE|0|1|run';
const DEPLOY_V0   = 'DEPLOY|0|600160005260206000f3';
const DEPLOY_V4   = 'DEPLOY|4|deadbeef|0|600160005260206000f3';

const WEIGHT_VECTORS = [
    { name: 'an ordinary SEND weighs the default 1', command: SEND_CMD, weight: 1 },
    { name: 'a top-level ISSUE weighs 1 (a row write like any other)', command: 'ISSUE|0|JDOG|1000', weight: 1 },
    { name: 'a child ISSUE weighs the same 1: exempt from the cap, never from the scale', command: 'ISSUE|0|JDOG.1|1', weight: 1 },
    { name: 'MINT weighs the default 1', command: 'MINT|0|PEPE|1', weight: 1 },
    { name: 'EXECUTE weighs the VM 30', command: EXEC_CMD, weight: 30 },
    { name: 'XEXEC rides with EXECUTE at 30', command: 'XEXEC|0|1|x', weight: 30 },
    { name: 'AIRDROP weighs the fan-out 25', command: 'AIRDROP|0|JDOG|1|1', weight: 25 },
    { name: 'DROP is an AIRDROP to the weight scan, alias and all', command: 'DROP|0|JDOG|1|1', weight: 25 },
    { name: 'DIVIDEND weighs the fan-out 25', command: 'DIVIDEND|0|JDOG|PEPE|1', weight: 25 },
    { name: 'inline DEPLOY (format 0) weighs the VM 30', command: DEPLOY_V0, weight: 30 },
    { name: 'a bare DEPLOY with no fields reads as format 0 and keeps the 30', command: 'DEPLOY', weight: 30 },
    { name: 'chunk-carrier DEPLOY (format 4) is a row write: weight 1', command: DEPLOY_V4, weight: 1 },
    // The discount reads the format through the arbiter's ONE derivation
    // (getFormatVersion), so its string normalizations apply identically.
    { name: 'a numeric-string 04 is format 4 to the shared derivation', command: 'DEPLOY|04|deadbeef|0|6001', weight: 1 },
    { name: 'a quoted "4" strips to format 4, exactly as the dispatcher reads it', command: 'DEPLOY|"4"|deadbeef|0|6001', weight: 1 },
    { name: 'format 1 keeps the full VM weight: only the carrier is discounted', command: 'DEPLOY|1|aabb', weight: 30 },
    { name: 'format 2 keeps the full VM weight', command: 'DEPLOY|2|aabb', weight: 30 },
    { name: 'format 3 keeps the full VM weight', command: 'DEPLOY|3|aabb', weight: 30 },
    { name: 'a float format is unparseable and falls through to the full weight', command: 'DEPLOY|4.5|aabb', weight: 30 },
    { name: 'an empty format field means format 0, never 4', command: 'DEPLOY||aabb', weight: 30 },
    { name: 'a non-numeric format falls through to the full weight', command: 'DEPLOY|carrier|aabb', weight: 30 },
    { name: 'an out-of-range format (>255) falls through to the full weight', command: 'DEPLOY|256|aabb', weight: 30 },
    // A lowercase name is not DEPLOY to either side (case-sensitive, like the
    // limit scan): it weighs the default 1, and the activation scan rejects
    // the batch whole before the weight ever matters.
    { name: 'a lowercase deploy is not DEPLOY and weighs the default 1', command: 'deploy|4|aabb', weight: 1 },
];

/*
 * Whole-batch boundary vectors at the 250 budget. `verdict` is the arbiter's
 * parse() STATUS; the SDK half derives its own from the mirrored rule
 * (count cap first, then the weight budget) so the two enforcement shapes are
 * compared, not just the arithmetic.
 */
const WEIGHT_BATCH_VECTORS = [
    {
        name: '8 EXECUTEs and 10 SENDs weigh the budget exactly and fit',
        tail: repeat(8, () => EXEC_CMD).concat(repeat(10, () => SEND_CMD)).join(';'),
        weight: 250, verdict: 'valid',
    },
    {
        name: '8 EXECUTEs and 11 SENDs weigh 251 and reject the batch whole',
        tail: repeat(8, () => EXEC_CMD).concat(repeat(11, () => SEND_CMD)).join(';'),
        weight: 251, verdict: 'invalid: COMMAND (limit)',
    },
    {
        name: 'an inline DEPLOY may carry 220 companions',
        tail: [DEPLOY_V0].concat(repeat(220, () => SEND_CMD)).join(';'),
        weight: 250, verdict: 'valid',
    },
    {
        name: 'an inline DEPLOY with 221 companions weighs 251 and rejects whole',
        tail: [DEPLOY_V0].concat(repeat(221, () => SEND_CMD)).join(';'),
        weight: 251, verdict: 'invalid: COMMAND (limit)',
    },
    {
        // The ruling's whole point: a carrier is a row write, so it shares its
        // batch with 249 companions instead of the 220 an inline DEPLOY buys.
        name: 'a chunk-carrier DEPLOY shares its batch with 249 companions',
        tail: [DEPLOY_V4].concat(repeat(249, () => SEND_CMD)).join(';'),
        weight: 250, verdict: 'valid',
    },
    {
        name: 'the carrier discount does not leak to its companions: one EXECUTE among them still counts 30',
        tail: [DEPLOY_V4].concat(repeat(248, () => SEND_CMD)).concat([EXEC_CMD]).join(';'),
        weight: 279, verdict: 'invalid: COMMAND (limit)',
    },
];

/*
 * Raw FORMAT fields driven through BOTH derivations (the SDK's formatVersion
 * mirror and the arbiter's util.getFormatVersion), so the discount can never
 * come to read a wire byte the dispatcher reads differently. `expected` pins
 * the absolute value for the shapes the discount turns on.
 */
const FORMAT_FIELD_VECTORS = [
    { field: undefined, expected: 0 },
    { field: '', expected: 0 },
    { field: '0', expected: 0 },
    { field: '4', expected: 4 },
    { field: '04', expected: 4 },
    { field: ' 4', expected: 4 },
    { field: '"4"', expected: 4 },
    { field: "'4'", expected: 4 },
    { field: 4, expected: 4 },
    { field: '4.5', expected: null },
    { field: 4.5, expected: null },
    { field: 'carrier', expected: null },
    { field: '255', expected: 255 },
    { field: '256', expected: null },
    { field: null, expected: null },
];

describe('BATCH limit-scan conformance (SDK mirror vs arbiter)', function () {

    it('pins the consensus numbers the mirror is built on, ungated and gated apart', function () {
        expect(BATCH_COMMAND_LIMIT).to.equal(250);
        // The UNGATED table, in force on both sides of the flag. DEPLOY must
        // stay OUT of it: putting the D5 cap here would apply it retroactively
        // to blocks that accepted more, which is a replay fork.
        expect(BATCH_ACTION_LIMITS).to.deep.equal({ BATCH: 0, MINT: 1, ISSUE: 1 });
        expect(BATCH_ACTION_LIMITS).to.not.have.property('DEPLOY');
        // The GATED table, merged only at/after BATCH_ISSUANCE_LIMITS (D5).
        expect(BATCH_GATED_ACTION_LIMITS).to.deep.equal({ DEPLOY: 1 });
        // What clients actually enforce: the merge, because the mirror speaks
        // for the post-flag rule set unconditionally.
        expect(BATCH_ACTION_LIMITS_ACTIVE).to.deep.equal({ BATCH: 0, MINT: 1, ISSUE: 1, DEPLOY: 1 });
        expect(CHILD_ISSUE_KEY).to.equal('ISSUE.CHILD');
    });

    it('buckets an unresolvable TICK under a Symbol no wire string can spell', function () {
        expect(typeof UNRESOLVED_TICK_KEY).to.equal('symbol');
        expect(mintTickKey('').key).to.equal(UNRESOLVED_TICK_KEY);
        expect(mintTickKey(undefined).key).to.equal(UNRESOLVED_TICK_KEY);
        // A real tick keys on its CASE-FOLDED self; only the caret form is aliasable.
        expect(mintTickKey('PEPE')).to.deep.equal({ key: 'pepe', aliasable: false });
        expect(mintTickKey('^614')).to.deep.equal({ key: '^614', aliasable: true });
    });

    it('folds TICK case, because the arbiter resolves ticker ids case-insensitively', function () {
        // xchain-indexer/src/db.js getTickerId resolves through
        // `WHERE LOWER(tick)=?` (and interning resolves before it inserts), so
        // JDOG and jdog are ONE id on chain and must be ONE bucket here. Keyed on
        // the literal string, this pair passed compose-time validation and the chain
        // rejected the whole batch with the fees already spent.
        expect(mintTickKey('JDOG').key).to.equal(mintTickKey('jdog').key);
        expect(maxMintsPerDistinctTick(['JDOG', 'jdog'])).to.deep.equal({ max: 2, approximate: false });
        // Distinct names stay distinct, so the fold cannot invent a refusal.
        expect(maxMintsPerDistinctTick(['JDOG', 'PEPE'])).to.deep.equal({ max: 1, approximate: false });
    });

    /*
     * R2b's ordering, tested on its own rather than only through the verdicts
     * it produces. The verdict vectors above cannot see WHY the order came out
     * right, so a mirror that re-derived it from a tally would keep them green
     * right up until an unrelated refactor moved a consensus string.
     */
    it('orders per-ACTION cap keys by FIRST APPEARANCE in the command list', function () {
        expect(limitKeysInListOrder('DEPLOY|0|6001;ISSUE|0|AAA|1;ISSUE|0|BBB|1;DEPLOY|0|6002'.split(';')))
            .to.deep.equal(['DEPLOY', 'ISSUE']);
        expect(limitKeysInListOrder('ISSUE|0|AAA|1;DEPLOY|0|6001;DEPLOY|0|6002;ISSUE|0|BBB|1'.split(';')))
            .to.deep.equal(['ISSUE', 'DEPLOY']);
        // Every distinct key takes a place, capped or not, and each takes it
        // exactly once however many times it recurs.
        expect(limitKeysInListOrder(['SEND|0|JDOG|1|addr', 'ISSUE|0|JDOG.1|1', 'MINT|0|PEPE|1',
            'MINT|0|PEPE|2', 'SEND|0|JDOG|2|addr']))
            .to.deep.equal(['SEND', CHILD_ISSUE_KEY, 'MINT']);
        expect(limitKeysInListOrder([])).to.deep.equal([]);
    });

    it('takes that order from the LIST, so a key that jumps object enumeration cannot move it', function () {
        // '0' is an integer-like property name: on a plain tally object it
        // enumerates BEFORE every string key regardless of insertion, which is
        // the concrete way a tally-driven loop and a list-driven loop part
        // company. Only an unknown ACTION can spell one (and that outranks the
        // caps anyway), so this asserts the ordering primitive directly.
        const entries = ['ISSUE|0|AAA|1', '0|0|x', 'ISSUE|0|BBB|1'];
        const counts = {};
        for (const e of entries) counts[classifyCommand(e)] = 1;
        expect(Object.keys(counts), 'object enumeration hoists the integer-like key')
            .to.deep.equal(['0', 'ISSUE']);
        expect(limitKeysInListOrder(entries), 'list order does not')
            .to.deep.equal(['ISSUE', '0']);
    });

    it('states a SEPARATE verdict per half only where a declared divergence explains it', function () {
        for (const v of VECTORS) {
            const split = v.arbiterVerdict !== undefined || v.sdkVerdict !== undefined;
            if (!split) {
                expect(v.divergence, v.name + ': agreeing vector must not name a divergence')
                    .to.equal(undefined);
                expect(v.verdict, v.name + ': agreeing vector must state one verdict')
                    .to.be.a('string');
                continue;
            }
            expect(v.divergence, v.name + ': a split verdict must name a DECLARED divergence')
                .to.be.oneOf(DECLARED_DIVERGENCES);
            expect(v.arbiterVerdict, v.name + ': a split vector states BOTH verdicts').to.be.a('string');
            expect(v.sdkVerdict, v.name + ': a split vector states BOTH verdicts').to.be.a('string');
            expect(v.arbiterVerdict, v.name + ': a split vector whose halves agree is not a divergence')
                .to.not.equal(v.sdkVerdict);
        }
    });

    describe('SDK half', function () {
        for (const v of VECTORS) {
            it(v.name, function () {
                const entries = v.tail.split(';');
                const expected = v.classes || entries.map(() => v.uniform);
                if (expected[0] !== undefined)
                    expect(entries.map(classifyCommand)).to.deep.equal(expected);
                const scan = scanBatch(v.tail);
                expect(scan.count, 'command count').to.equal(v.count);
                expect(verdictOf(scan), 'whole-batch verdict').to.equal(sdkVerdictOf(v));
                if (v.mintMax !== undefined)
                    expect(scan.mint.max, 'mirror per-token MINT maximum').to.equal(v.mintMax);
                // Asserted on EVERY vector, so the flag cannot start firing
                // where it should not (silencing a real MINT violation) or
                // stop firing where it must (hiding the caret divergence).
                expect(scan.mint.approximate, 'mirror approximation flag')
                    .to.equal(v.approximate === true);
            });
        }
    });

    /*
     * The arbiter half. Drives the REAL xchain-indexer Batch handler over the
     * same vectors with in-memory stubs: the genuine ProtocolChanges registry
     * (so the activation scan that turns a lowercase or empty ACTION into
     * `invalid: ACTION (unknown)` is the real one) and no-op persistence.
     * ISSUANCE_FEE is forced off, which parks the aggregate gas pre-check: that
     * is a different rule with its own row, and this suite is about
     * classification and counting.
     *
     * getTickerId is a REAL resolver over a fixed name->id map, not a constant.
     * D7 buckets MINTs by resolved id, so a constant resolver makes every MINT
     * one token and every distinctness vector vacuous.
     */
    describe('arbiter half (sibling xchain-indexer checkout)', function () {
        let makeHandler = null;

        before(function () {
            this.timeout(30000);
            const roots = [process.env.XCHAIN_INDEXER_PATH,
                path.join(__dirname, '..', '..', '..', 'xchain-indexer')].filter(Boolean);
            const root = roots.find((r) => fs.existsSync(path.join(r, 'src', 'actions', 'batch.js')));
            if (!root) return this.skip();

            process.env.INDEXER_COIN = process.env.INDEXER_COIN || 'BTC';
            process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';
            let Batch, IdxUtility, IdxConfig, ProtocolChanges;
            try {
                Batch = require(path.join(root, 'src', 'actions', 'batch.js'));
                IdxUtility = require(path.join(root, 'src', 'utility.js'));
                IdxConfig = require(path.join(root, 'src', 'config.js'));
                ProtocolChanges = require(path.join(root, 'src', 'protocol_changes.js'));
            } catch (e) {
                return this.skip();
            }

            // Mirror of xchain-indexer/src/db.js getTickerId, over the fixed
            // token set above: a CANONICAL `^<id>` resolves straight to that id
            // and only when a row backs it (a dangling caret is null, never a
            // phantom id), a name resolves case-insensitively, and anything
            // unknown - including a non-canonical caret, which falls through to
            // the name lookup as a literal string - is null.
            const CANONICAL_CARET_ID = /^[1-9][0-9]*$/;
            const getTickerId = async function (tick) {
                const str = String(tick);
                const pid = str.substring(1);
                if (str.charAt(0) === '^' && CANONICAL_CARET_ID.test(pid))
                    return EXISTING_TICKER_IDS.has(Number(pid)) ? Number(pid) : null;
                const hit = TICKER_IDS.get(str.toLowerCase());
                return hit === undefined ? null : hit;
            };

            const blockTime = Math.floor(Date.now() / 1000);
            // `off` lists flags forced inactive for this handler, so one vector
            // set can also be driven BELOW a flag day.
            makeHandler = function (off) {
                const disabled = off || ['ISSUANCE_FEE'];
                const util = new IdxUtility();
                const config = typeof IdxConfig.getConfig === 'function' ? IdxConfig.getConfig() : IdxConfig;
                const decoderDb = { getBlockTime: async () => blockTime };
                const indexerDb = {
                    createBatch: async () => {},
                    createActionIndex: async () => 1,
                    isActionAllowed: async () => true,
                    getTokenInfo: async () => null,
                    getAddressBalances: async () => [],
                    getTickerId,
                    suppressIndexIdCreation: false,
                };
                const changes = new ProtocolChanges({ config, util, decoderDb, indexerDb });
                const dispatched = [];
                const handler = new Batch({
                    config, util, decoderDb, indexerDb,
                    mapper: { createMappings: async () => {} },
                    protocolChanges: {
                        isEnabled: async (name, blockIndex) =>
                            (disabled.includes(name) ? false : changes.isEnabled(name, blockIndex)),
                    },
                    processAction: async (action) => { dispatched.push(action); },
                    actionAliases: { TRANSFER: 'SEND', ADDR: 'ADDRESS', DROP: 'AIRDROP', CAST: 'BROADCAST', MSG: 'MESSAGE' },
                });
                return { handler, dispatched };
            };
        });

        // The arbiter reads the leading token, alias-expands it, THEN classifies;
        // reproduce that call shape rather than a convenience wrapper.
        function arbiterClass(handler, command) {
            const action = handler.normalizeSubAction(String(command).split('|')[0]);
            return handler.classifyLimitAction(action, command, true);
        }

        async function arbiterVerdict(handler, dispatched, tail) {
            const data = {
                ACTION: 'BATCH', FORMAT: 0, BLOCK_INDEX: 200,
                SOURCE: 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
                TX_DATA: 'BATCH|0|' + tail,
            };
            // The handler narrates every sub-command to stdout; a 250-command
            // vector would bury the reporter.
            const log = console.log;
            console.log = () => {};
            try { await handler.parse(['0'], data, null); } finally { console.log = log; }
            return { status: data['STATUS'], dispatched: dispatched.length };
        }

        it('mirrors the arbiter limit tables byte-for-byte, ungated and gated apart', function () {
            const { handler } = makeHandler();
            expect(handler.commandLimit).to.equal(BATCH_COMMAND_LIMIT);
            expect(handler.actionLimits).to.deep.equal(BATCH_ACTION_LIMITS);
            expect(handler.gatedActionLimits).to.deep.equal(BATCH_GATED_ACTION_LIMITS);
            // The merge the arbiter performs at/after the flag is exactly what
            // the mirror enforces unconditionally, so an edit to EITHER arbiter
            // table reddens here rather than at a flag day.
            expect(Object.assign({}, handler.actionLimits, handler.gatedActionLimits))
                .to.deep.equal(BATCH_ACTION_LIMITS_ACTIVE);
            expect(handler.childIssueKey).to.equal(CHILD_ISSUE_KEY);
            expect(typeof handler.unresolvedTickKey).to.equal('symbol');
        });

        it('leaves DEPLOY uncapped BELOW the flag, which is why the tables are kept apart', async function () {
            this.timeout(20000);
            const { handler, dispatched } = makeHandler(['ISSUANCE_FEE', 'BATCH_ISSUANCE_LIMITS']);
            const tail = 'DEPLOY|0|600160005260206000f3;DEPLOY|0|600260005260206000f3';
            const got = await arbiterVerdict(handler, dispatched, tail);
            expect(got.status, 'pre-flag verdict').to.equal('valid');
            expect(got.dispatched, 'both DEPLOYs run below the flag').to.equal(2);
        });

        for (const v of VECTORS) {
            it(v.name, async function () {
                this.timeout(20000);
                const { handler, dispatched } = makeHandler();
                const entries = v.tail.split(';');
                const expected = v.classes || entries.map(() => v.uniform);
                if (expected[0] !== undefined)
                    expect(entries.map((e) => arbiterClass(handler, e))).to.deep.equal(expected);

                // The arbiter's own per-token MINT maximum, over RESOLVED ids,
                // read from the same helper parse() substitutes for the raw
                // count. Where this differs from the mirror's `mintMax` the
                // divergence is stated as a NUMBER, not inferred from an error
                // string.
                if (v.arbiterMintMax !== undefined) {
                    const ticks = entries
                        .filter((e) => arbiterClass(handler, e) === 'MINT')
                        .map((e) => handler.subCommandTick('MINT', e, true));
                    expect(await handler.maxMintsPerDistinctTick(ticks),
                        'arbiter per-distinct-token MINT maximum').to.equal(v.arbiterMintMax);
                }

                const got = await arbiterVerdict(handler, dispatched, v.tail);
                expect(got.status, 'arbiter verdict').to.equal(arbiterVerdictOf(v));
                // A valid batch dispatches one sub-command per counted command:
                // that dispatch count IS the arbiter's count, and it must equal
                // the SDK's. An invalid batch dispatches nothing, and its count
                // is pinned by the cap boundary vectors either side of 250.
                if (arbiterVerdictOf(v) === 'valid')
                    expect(got.dispatched, 'arbiter command count').to.equal(scanBatch(v.tail).count);
            });
        }
    });

    /*
     * BATCH_COST_WEIGHTING conformance: the weight table, the chunk-carrier
     * DEPLOY discount, and the budget boundary, driven through the SDK mirror
     * and (with the sibling checkout) the arbiter's own weight scan and a full
     * parse() verdict. Same skip posture as the arbiter half above.
     */
    describe('weight conformance (BATCH_COST_WEIGHTING)', function () {

        describe('SDK half', function () {

            it('pins the budget and the table the vectors are stated against', function () {
                expect(BATCH_WEIGHT_BUDGET).to.equal(250);
                expect(BATCH_COMMAND_WEIGHTS).to.deep.equal({
                    AIRDROP: 25, DIVIDEND: 25, DEPLOY: 30, EXECUTE: 30, XEXEC: 30,
                });
            });

            for (const v of WEIGHT_VECTORS) {
                it(v.name, function () {
                    expect(subCommandWeight(v.command), 'mirror weight').to.equal(v.weight);
                });
            }

            for (const v of WEIGHT_BATCH_VECTORS) {
                it(v.name, function () {
                    const entries = v.tail.split(';');
                    expect(batchWeight(entries), 'mirror batch weight').to.equal(v.weight);
                    // The mirrored enforcement shape: the count cap runs first
                    // as a sound pre-filter, then the budget. Every boundary
                    // vector fits the count, so the verdict here IS the budget's.
                    const over = entries.length > BATCH_COMMAND_LIMIT || batchWeight(entries) > BATCH_WEIGHT_BUDGET;
                    expect(over, 'mirror verdict').to.equal(v.verdict !== 'valid');
                    // The arithmetic above is not the canonical scan. scanBatch is
                    // what an outside consumer reads for the whole-batch verdict,
                    // and it does not restate this rule, so it is asserted here
                    // rather than inferred from the sum.
                    const scan = scanBatch(v.tail);
                    expect(verdictOf(scan), 'scanBatch whole-batch verdict').to.equal(v.verdict);
                    if (v.verdict !== 'valid') {
                        expect(scan.violation.kind, 'a weight overflow is its own kind').to.equal('WEIGHT_LIMIT');
                        expect(scan.violation.weight, 'the measured weight rides the violation').to.equal(v.weight);
                        // The one kind a mainnet chain may not raise, so a caller
                        // can tell it from the rules that are armed everywhere.
                        expect(scan.violation.flagGated, 'weight is flag-gated').to.equal(true);
                    }
                });
            }
        });

        describe('arbiter half (sibling xchain-indexer checkout)', function () {
            let makeHandler = null;
            let idxUtil = null;

            before(function () {
                this.timeout(30000);
                const roots = [process.env.XCHAIN_INDEXER_PATH,
                    path.join(__dirname, '..', '..', '..', 'xchain-indexer')].filter(Boolean);
                const root = roots.find((r) => fs.existsSync(path.join(r, 'src', 'actions', 'batch.js')));
                if (!root) return this.skip();

                process.env.INDEXER_COIN = process.env.INDEXER_COIN || 'BTC';
                process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';
                let Batch, IdxUtility, IdxConfig, ProtocolChanges;
                try {
                    Batch = require(path.join(root, 'src', 'actions', 'batch.js'));
                    IdxUtility = require(path.join(root, 'src', 'utility.js'));
                    IdxConfig = require(path.join(root, 'src', 'config.js'));
                    ProtocolChanges = require(path.join(root, 'src', 'protocol_changes.js'));
                } catch (e) {
                    return this.skip();
                }
                idxUtil = new IdxUtility();

                const blockTime = Math.floor(Date.now() / 1000);
                makeHandler = function () {
                    const util = new IdxUtility();
                    const config = typeof IdxConfig.getConfig === 'function' ? IdxConfig.getConfig() : IdxConfig;
                    const decoderDb = { getBlockTime: async () => blockTime };
                    const indexerDb = {
                        createBatch: async () => {},
                        createActionIndex: async () => 1,
                        isActionAllowed: async () => true,
                        getTokenInfo: async () => null,
                        getAddressBalances: async () => [],
                        getTickerId: async () => null,
                        suppressIndexIdCreation: false,
                    };
                    const changes = new ProtocolChanges({ config, util, decoderDb, indexerDb });
                    const dispatched = [];
                    const handler = new Batch({
                        config, util, decoderDb, indexerDb,
                        mapper: { createMappings: async () => {} },
                        protocolChanges: {
                            isEnabled: async (name, blockIndex) =>
                                (name === 'ISSUANCE_FEE' ? false : changes.isEnabled(name, blockIndex)),
                        },
                        processAction: async (action) => { dispatched.push(action); },
                        actionAliases: { TRANSFER: 'SEND', ADDR: 'ADDRESS', DROP: 'AIRDROP', CAST: 'BROADCAST', MSG: 'MESSAGE' },
                    });
                    return { handler, dispatched };
                };
            });

            it('mirrors the arbiter budget and weight table byte-for-byte', function () {
                const { handler } = makeHandler();
                expect(handler.weightBudget).to.equal(BATCH_WEIGHT_BUDGET);
                expect(handler.commandWeights).to.deep.equal(BATCH_COMMAND_WEIGHTS);
            });

            it('derives the FORMAT byte identically to the arbiter, field for field', function () {
                for (const v of FORMAT_FIELD_VECTORS) {
                    const label = 'field ' + JSON.stringify(v.field === undefined ? 'undefined' : v.field);
                    expect(formatVersion(v.field), 'mirror ' + label).to.equal(v.expected);
                    expect(idxUtil.getFormatVersion(v.field), 'arbiter ' + label).to.equal(v.expected);
                }
            });

            for (const v of WEIGHT_VECTORS) {
                it(v.name, async function () {
                    this.timeout(20000);
                    const { handler } = makeHandler();
                    // batchWeight over one command exercises the arbiter's whole
                    // derivation path (action read, alias normalization, the
                    // DEPLOY format read), exactly as parse() weighs it.
                    const arbiter = await handler.batchWeight([v.command], { BLOCK_INDEX: 200 }, true);
                    expect(arbiter, 'arbiter weight').to.equal(v.weight);
                    expect(subCommandWeight(v.command), 'mirror weight').to.equal(v.weight);
                });
            }

            for (const v of WEIGHT_BATCH_VECTORS) {
                it(v.name, async function () {
                    this.timeout(20000);
                    const { handler, dispatched } = makeHandler();
                    const entries = v.tail.split(';');
                    expect(await handler.batchWeight(entries, { BLOCK_INDEX: 200 }, true),
                        'arbiter batch weight').to.equal(v.weight);

                    const data = {
                        ACTION: 'BATCH', FORMAT: 0, BLOCK_INDEX: 200,
                        SOURCE: 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
                        TX_DATA: 'BATCH|0|' + v.tail,
                    };
                    const log = console.log;
                    console.log = () => {};
                    try { await handler.parse(['0'], data, null); } finally { console.log = log; }
                    expect(data['STATUS'], 'arbiter verdict').to.equal(v.verdict);
                    if (v.verdict === 'valid')
                        expect(dispatched.length, 'every sub-command runs').to.equal(entries.length);
                    else
                        expect(dispatched.length, 'no sub-command runs').to.equal(0);
                });
            }
        });
    });
});
