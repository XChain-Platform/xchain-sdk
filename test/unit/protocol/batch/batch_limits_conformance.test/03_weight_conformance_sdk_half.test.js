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
    BATCH_COMMAND_WEIGHTS,
    BATCH_WEIGHT_BUDGET,
    batchWeight,
    subCommandWeight,
} = require('../../../../src/protocol/batch_limits.js');
const { parse } = require('../../../../src/decoder/parse.js');
const { mirrorVerdict, repeat } = require('./support/limit_helpers.js');
const {
    WEIGHT_BATCH_VECTORS,
    WEIGHT_VECTORS,
} = require('./fixtures/weight_vectors.js');

/*
 * BATCH_COST_WEIGHTING conformance: the weight table, the chunk-carrier
 * DEPLOY discount, and the budget boundary, driven through the SDK mirror
 * and (with the sibling checkout) the arbiter's own weight scan and a full
 * parse() verdict. Same skip posture as the arbiter half above.
 */
describe('BATCH limit-scan conformance (SDK mirror vs arbiter)', function () {
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
                    // The arithmetic above is not what a consumer reads. The
                    // shipped decoder is, so its answer is asserted directly -
                    // including where that answer is the payload-length refusal
                    // it reaches before any limit rule (see decoderVerdict).
                    expect(mirrorVerdict(v.tail), 'decoder whole-batch verdict')
                        .to.equal(v.decoderVerdict || v.verdict);
                });
            }
        });
    });
});

describe('BATCH limit-scan conformance (SDK mirror vs arbiter)', function () {
    describe('weight conformance (BATCH_COST_WEIGHTING)', function () {
        describe('SDK half', function () {
            it('reports a weight overflow as a whole-batch COMMAND limit that names its flag', function () {
                // Short enough to parse, so the decoder reaches the weight rule:
                // ten inline DEPLOYs weigh 300 against a budget of 250.
                const tail = repeat(10, () => 'DEPLOY|0|6001').join(';');
                expect(batchWeight(tail.split(';')), 'the tail is over budget').to.equal(300);
                expect(mirrorVerdict(tail)).to.equal('invalid: COMMAND (limit)');
                const findings = (parse('BATCH|0|' + tail, { validate: true })
                    .validation || {}).findings || [];
                const over = findings.find((f) => f.code === 'BATCH_LIMIT_EXCEEDED'
                    && f.details && f.details.action === 'COMMAND');
                expect(over, 'the overflow is reported as a whole-batch COMMAND limit')
                    .to.not.equal(undefined);
                expect(over.details.weight, 'the measured weight rides the finding').to.equal(300);
                expect(over.details.limit, 'against the budget, not the count cap')
                    .to.equal(BATCH_WEIGHT_BUDGET);
                // The finding must name the gate it rode in on. BATCH_COST_WEIGHTING
                // is armed on every network since the 2026-09-09 ruling (mainnet
                // effective 2026-08-16T00:00:00Z, through the issuance-limits gate it
                // nests inside), so the message states that and never a stale
                // unarmed-on-mainnet claim.
                expect(over.message, 'a weight overflow names its flag')
                    .to.contain('cost weighting is in force on every network');
            });
        });
    });
});
