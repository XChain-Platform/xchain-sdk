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

const { repeat } = require('../support/limit_helpers.js');

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
/*
 * `decoderVerdict` on a vector below records that the SHIPPED decoder answers
 * this tail before the weight rule is ever reached: a batch carrying 220-odd
 * DEPLOY/SEND companions is longer than the wire payload `parse` will accept,
 * so it refuses with TOO_LONG. The weight arithmetic those vectors exist for
 * is still asserted directly (`batchWeight` above), and the finding SHAPE a
 * weight overflow produces is pinned by its own case below on a tail short
 * enough to parse. Stating the parse failure is the point: it is what a
 * consumer really sees, where the deleted scanBatch helper answered
 * a verdict no shipped code path would have reached.
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
        weight: 250, verdict: 'valid', decoderVerdict: 'parse failure: TOO_LONG',
    },
    {
        name: 'an inline DEPLOY with 221 companions weighs 251 and rejects whole',
        tail: [DEPLOY_V0].concat(repeat(221, () => SEND_CMD)).join(';'),
        weight: 251, verdict: 'invalid: COMMAND (limit)', decoderVerdict: 'parse failure: TOO_LONG',
    },
    {
        // The ruling's whole point: a carrier is a row write, so it shares its
        // batch with 249 companions instead of the 220 an inline DEPLOY buys.
        name: 'a chunk-carrier DEPLOY shares its batch with 249 companions',
        tail: [DEPLOY_V4].concat(repeat(249, () => SEND_CMD)).join(';'),
        weight: 250, verdict: 'valid', decoderVerdict: 'parse failure: TOO_LONG',
    },
    {
        name: 'the carrier discount does not leak to its companions: one EXECUTE among them still counts 30',
        tail: [DEPLOY_V4].concat(repeat(248, () => SEND_CMD)).concat([EXEC_CMD]).join(';'),
        weight: 279, verdict: 'invalid: COMMAND (limit)',
        decoderVerdict: 'parse failure: TOO_LONG',
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

module.exports = {
    DEPLOY_V0,
    DEPLOY_V4,
    EXEC_CMD,
    FORMAT_FIELD_VECTORS,
    SEND_CMD,
    WEIGHT_BATCH_VECTORS,
    WEIGHT_VECTORS,
};
