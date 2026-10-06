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
 * The two divergences src/protocol/batch_limits.js DECLARES in its header. A vector may
 * state a different verdict per half only by naming one of these.
 */
const CARET_ALIAS = 'caret alias (declared divergence 1: detectable, flagged approximate)';
const UNRESOLVABLE = 'unresolvable tick (declared divergence 2: undetectable client-side)';

const LIMIT_VECTORS_TAIL = [
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

module.exports = {
    CARET_ALIAS,
    LIMIT_VECTORS_TAIL,
    UNRESOLVABLE,
};
