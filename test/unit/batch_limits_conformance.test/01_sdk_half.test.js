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
    classifyCommand,
} = require('../../../src/protocol/batch_limits.js');
const { parse } = require('../../../src/decoder/parse.js');
const {
    mirrorMint,
    mirrorVerdict,
    repeat,
    sdkVerdictOf,
} = require('./support/limit_helpers.js');
const { VECTORS } = require('./fixtures/limit_vectors.js');

describe('BATCH limit-scan conformance (SDK mirror vs arbiter)', function () {
    describe('SDK half', function () {
        it('the cap is reported alone, so no per-command finding can outrank it', function () {
            // The arbiter checks the command cap FIRST and rejects the whole
            // batch there, never reaching the unknown-ACTION scan a trailing
            // empty command would otherwise trip. The decoder matches that by
            // emitting the cap and NOTHING else - which is why the vector below
            // reads 'invalid: COMMAND (limit)' and not 'ACTION (unknown)'. Pinned
            // directly because a decoder that started reporting both would move
            // a consensus error string with every vector still green.
            const tail = repeat(250, (i) => 'ISSUE|0|JDOG.' + i + '|1').join(';') + ';';
            expect(tail.split(';').length, 'over the cap, with an empty last command').to.equal(251);
            const findings = (parse('BATCH|0|' + tail, { validate: true })
                .validation || {}).findings || [];
            expect(findings.some((f) => f.code === 'BATCH_LIMIT_EXCEEDED'
                && f.details.action === 'COMMAND'), 'the cap is reported').to.equal(true);
            expect(findings.filter((f) => f.code === 'BATCH_COMMAND_INVALID'),
                'no per-command finding survives the cap').to.deep.equal([]);
            expect(mirrorVerdict(tail)).to.equal('invalid: COMMAND (limit)');
        });
    });
});

describe('BATCH limit-scan conformance (SDK mirror vs arbiter)', function () {
    describe('SDK half', function () {
        for (const v of VECTORS) {
            it(v.name, function () {
                const entries = v.tail.split(';');
                const expected = v.classes || entries.map(() => v.uniform);
                if (expected[0] !== undefined)
                    expect(entries.map(classifyCommand)).to.deep.equal(expected);
                // The arbiter's count is the raw ';'-split length, empties
                // included; that is what `entries` is, and every downstream
                // rule here is stated against it.
                expect(entries.length, 'command count').to.equal(v.count);
                expect(mirrorVerdict(v.tail), 'whole-batch verdict')
                    .to.equal(v.decoderVerdict || sdkVerdictOf(v));
                const mint = mirrorMint(entries);
                if (v.mintMax !== undefined)
                    expect(mint.max, 'mirror per-token MINT maximum').to.equal(v.mintMax);
                // Asserted on EVERY vector, so the flag cannot start firing
                // where it should not (silencing a real MINT violation) or
                // stop firing where it must (hiding the caret divergence).
                expect(mint.approximate, 'mirror approximation flag')
                    .to.equal(v.approximate === true);
            });
        }
    });
});
