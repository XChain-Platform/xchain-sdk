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

const {
    classifyCommand,
    commandTick,
    maxMintsPerDistinctTick,
} = require('../../../../src/protocol/batch_limits.js');
const { parse } = require('../../../../src/decoder/parse.js');

/*
 * THE SDK HALF IS THE SHIPPED DECODER, NOT A SECOND SCANNER.
 *
 * The SDK half drives `decoder/parse.js`, the code a consumer actually gets,
 * rather than a `scanBatch` helper kept in batch_limits.js for this test alone.
 * Such a helper restates the arbiter's whole precedence chain a second time
 * with no caller in the SDK, and a mirror only the test reads proves the test,
 * not the product.
 *
 * `mirrorVerdict` translates parse's finding vocabulary into the arbiter's
 * error strings, applying the arbiter's OWN precedence (whole-batch cap or
 * weight first, then an unknown/empty ACTION, then the first per-action cap),
 * because parse returns command-level findings ahead of batch-level ones and
 * that list order is a presentation detail rather than a consensus rule.
 */
function mirrorVerdict(tail) {
    const result = parse('BATCH|0|' + String(tail), { validate: true });

    // Nested BATCH is a categorical PARSE failure client-side, not a finding:
    // BATCH's cap of 0 means no readable batch can contain one at all.
    if (!result.ok) return 'parse failure: ' + result.code;

    const findings = (result.validation && result.validation.findings) || [];
    const limits = findings.filter((f) => f.code === 'BATCH_LIMIT_EXCEEDED');

    // The count cap and the weight budget both reject the whole batch under
    // `COMMAND`, and both run ahead of every per-action count on chain. The
    // decoder already honours that precedence by reporting the cap ALONE (it
    // is pinned below, 'the cap is reported alone...'), so this branch is a
    // guard against that changing under the translation, not the rule itself.
    if (limits.some((f) => f.details && f.details.action === 'COMMAND'))
        return 'invalid: COMMAND (limit)';

    // An unregistered ACTION name - the empty string an empty command yields
    // included - kills the whole batch before any per-action cap is counted.
    if (findings.some((f) => f.code === 'BATCH_COMMAND_INVALID'
        && f.details && (f.details.code === 'UNKNOWN_ACTION' || f.details.code === 'EMPTY')))
        return 'invalid: ACTION (unknown)';

    // Among per-action caps the FIRST finding wins, and parse emits them in
    // limitKeysInListOrder, which is protocol rule R2b's first-appearance rule.
    if (limits.length) return 'invalid: ' + limits[0].details.action + ' (limit)';

    return 'valid';
}

/*
 * The mirror's per-token MINT maximum, assembled from the SAME two primitives
 * decoder/parse.js assembles it from, so the number asserted here is the one
 * the shipped cap loop compares against rather than a test-local recount.
 */
function mirrorMint(entries) {
    const ticks = entries.filter((e) => classifyCommand(e) === 'MINT').map(commandTick);
    return ticks.length ? maxMintsPerDistinctTick(ticks) : { max: 0, approximate: false };
}

const repeat = (n, f) => Array.from({ length: n }, (_, i) => f(i));

const arbiterVerdictOf = (v) => (v.arbiterVerdict !== undefined ? v.arbiterVerdict : v.verdict);
const sdkVerdictOf = (v) => (v.sdkVerdict !== undefined ? v.sdkVerdict : v.verdict);

module.exports = {
    arbiterVerdictOf,
    mirrorMint,
    mirrorVerdict,
    repeat,
    sdkVerdictOf,
};
