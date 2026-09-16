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
 * src/protocol/batch_limits.js). A vector that straddles one of those two declared
 * divergences carries `arbiterVerdict` and `sdkVerdict` SEPARATELY plus a
 * `divergence` naming which one it pins - never a single verdict massaged
 * until both halves agree, which is how a divergence gets discovered in
 * production instead of here. A meta-test enforces that shape: a vector may
 * state two verdicts ONLY if it names a declared divergence, so a future edit
 * cannot quietly split a vector's expectations to make a failure go away.
 ********************************************************************/

const { CHILD_ISSUE_KEY } = require('../../../../../src/protocol/batch_limits.js');
const { repeat } = require('../support/limit_helpers.js');

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
const LIMIT_VECTORS_HEAD = [
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
     * sub-command appears EARLIEST in the command list (protocol rule R2b). That string
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
        //
        // `decoderVerdict`: the SHIPPED client expresses BATCH's cap of 0 as a
        // categorical PARSE refusal rather than a limit finding, and a parse
        // refusal has no position - so the SDK side cannot distinguish this
        // vector from its mirror image below, and does not pretend to. Both
        // halves still REJECT; only the error name differs, and the arbiter
        // half below pins the consensus string for both directions.
        name: 'a leading nested BATCH names the error over a later ISSUE break',
        tail: 'BATCH|0|ISSUE|0|X|1;ISSUE|0|AAA|1;ISSUE|0|BBB|1',
        classes: ['BATCH', 'ISSUE', 'ISSUE'], count: 3,
        verdict: 'invalid: BATCH (limit)',
        decoderVerdict: 'parse failure: NESTED_BATCH_FORBIDDEN',
    },
    {
        name: 'a leading ISSUE break names the error over a later nested BATCH',
        tail: 'ISSUE|0|AAA|1;ISSUE|0|BBB|1;BATCH|0|ISSUE|0|X|1',
        classes: ['ISSUE', 'ISSUE', 'BATCH'], count: 3,
        verdict: 'invalid: ISSUE (limit)',
        decoderVerdict: 'parse failure: NESTED_BATCH_FORBIDDEN',
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
];

module.exports = { LIMIT_VECTORS_HEAD };
