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

const { expect } = require('chai');

const {
    BATCH_COMMAND_LIMIT,
    BATCH_ACTION_LIMITS,
    BATCH_GATED_ACTION_LIMITS,
    BATCH_ACTION_LIMITS_ACTIVE,
    CHILD_ISSUE_KEY,
    UNRESOLVED_TICK_KEY,
    classifyCommand,
    limitKeysInListOrder,
    maxMintsPerDistinctTick,
    mintTickKey,
} = require('../../src/protocol/batch_limits.js');
const {
    CARET_ALIAS,
    DECLARED_DIVERGENCES,
    UNRESOLVABLE,
    VECTORS,
} = require('./batch_limits_conformance.test/fixtures/limit_vectors.js');

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
        // xchain-indexer/src/db/index_tables.js getTickerId resolves through
        // `WHERE LOWER(tick)=?` (and interning resolves before it inserts), so
        // JDOG and jdog are ONE id on chain and must be ONE bucket here. Keyed on
        // the literal string, this pair passed compose-time validation and the chain
        // rejected the whole batch with the fees already spent.
        expect(mintTickKey('JDOG').key).to.equal(mintTickKey('jdog').key);
        expect(maxMintsPerDistinctTick(['JDOG', 'jdog'])).to.deep.equal({ max: 2, approximate: false });
        // Distinct names stay distinct, so the fold cannot invent a refusal.
        expect(maxMintsPerDistinctTick(['JDOG', 'PEPE'])).to.deep.equal({ max: 1, approximate: false });
    });
});

describe('BATCH limit-scan conformance (SDK mirror vs arbiter)', function () {

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
});

describe('BATCH limit-scan conformance (SDK mirror vs arbiter)', function () {

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
});
