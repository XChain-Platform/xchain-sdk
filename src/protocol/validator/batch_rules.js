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
 * XChain Platform SDK - Validator
 *
 * Per-action input validation rules for all 30 ACTION types
 *
 ********************************************************************/

// BATCH limit scan (command cap and dotted-TICK child classification), shared
// with the builder, the decoder mirror, and preflight validation.
const {
    BATCH_ACTION_LIMITS_ACTIVE,
    BATCH_COMMAND_LIMIT,
    BATCH_WEIGHT_BUDGET,
    batchWeight,
    classifyCommand,
    commandTick,
    limitKeysInListOrder,
    maxMintsPerDistinctTick,
} = require('../batch_limits.js');
const { BATCH_LIMIT_MESSAGES } = require('./field_limits.js');

// Checks whole-batch limits first because they take precedence over child findings.
function validateBatchEnvelope(validator, commands, errors) {
    // Global command cap, FIRST and alone. The arbiter rejects an over-cap
    // BATCH as one record before any other scan runs, so reporting the cap
    // and stopping mirrors both the verdict and its precedence - and spares
    // the caller a full per-command parse of a batch the chain never reads.
    // Empty elements count, exactly as they do on-chain.
    if (commands.length > BATCH_COMMAND_LIMIT) {
        errors.push(validator._error('BATCH_CONSTRAINT',
            'BATCH can contain at most ' + BATCH_COMMAND_LIMIT + ' commands',
            { count: commands.length, limit: BATCH_COMMAND_LIMIT }));
        return false;
    }

    // BATCH_COST_WEIGHTING: the same whole-batch rejection, reached by
    // WEIGHT instead of count, in the same position the arbiter checks it.
    // Weighed only when the count already fits, which is the arbiter's own
    // ordering: every weight is an integer >= 1, so the count check is a
    // sound pre-filter and a batch over the count reports the count. The
    // early return mirrors the cap's precedence too: on-chain the budget
    // rejects the batch before any per-action scan runs, so per-command
    // findings here would describe rules the chain never reads.
    let weight = batchWeight(commands);
    if (weight > BATCH_WEIGHT_BUDGET) {
        errors.push(validator._error('BATCH_CONSTRAINT',
            'BATCH commands weigh ' + weight + ' (VM and fan-out actions cost more than 1 each); '
            + 'the chain rejects the whole batch above a total weight of ' + BATCH_WEIGHT_BUDGET,
            { count: commands.length, weight, limit: BATCH_WEIGHT_BUDGET }));
        return false;
    }
    return true;
}

// Scans children once so counts and detailed findings use the same command view.
function scanBatchCommands(validator, commands, errors) {
    // Occurrences per counting key, and the MINT TICKs, collected in ONE
    // pass so the two can never disagree about which entries are MINTs.
    let counts = {};
    let mintTicks = [];
    let fileCount = 0;
    for (let i = 0; i < commands.length; i++) {
        let cmd = commands[i];
        // Child (dotted-TICK) issuances are exempt from the top-level limit
        // of 1; a caret TICK never is. classifyCommand reads the TICK the
        // executor will see, so a legacy no-VERSION command classifies off
        // params[0] the same way the arbiter's injection makes it params[1].
        let key = classifyCommand(cmd);
        counts[key] = (counts[key] || 0) + 1;
        if (key === 'MINT') mintTicks.push(commandTick(cmd));
        if (key === 'FILE') fileCount++;

        // Nested BATCH is reported HERE rather than with the counted caps
        // below because this is also where descent stops: handing a child
        // BATCH to validateBatchCommand would re-enter this method.
        if (key === 'BATCH') {
            errors.push(validator._error('BATCH_CONSTRAINT', 'BATCH cannot contain nested BATCH actions'));
            continue;                         // never descend into a forbidden child
        }
        errors.push(...validator.validateBatchCommand(cmd, i));
    }
    return { counts, mintTicks, fileCount };
}

// Appends counted caps in their first-appearance order to preserve precedence.
function appendBatchLimits(validator, commands, state, mint, errors) {
    // The caps come from the shared mirror, so a limit change (or a new
    // capped action) lands in batch_limits.js alone. BATCH is skipped: its
    // limit of 0 was already reported per occurrence in the descent-stop
    // above. The issuance limits are active on every network, from genesis
    // on testnet and regtest and from the configured mainnet activation.
    // Parent plus child issuances and MINTs of several distinct tokens are
    // accepted after activation. DEPLOY is capped on both sides of the flag.
    // Keys are read in FIRST-APPEARANCE order through the shared mirror,
    // never `Object.keys` insertion order.
    for (let key of limitKeysInListOrder(commands)) {
        let limit = BATCH_ACTION_LIMITS_ACTIVE[key];
        if (limit === undefined || key === 'BATCH') continue;
        let observed = key === 'MINT' ? mint.max : state.counts[key];
        if (observed > limit)
            errors.push(validator._error('BATCH_CONSTRAINT',
                BATCH_LIMIT_MESSAGES[key] || ('BATCH can contain at most ' + limit + ' ' + key + ' action(s)'),
                { count: observed, limit }));
    }
}

// Adds alias ambiguity after counted caps because only this finding needs resolution.
function appendMintAliasFinding(validator, mint, mintTicks, errors) {
    // Reported after the counted caps so a batch already over a limit on the
    // strings alone gets that precise finding first. The remaining verdict
    // depends on resolution only an indexer can do: a name and caret id can
    // identify the same scarce token. This compose-side check refuses that
    // ambiguous spelling, and the decoder reuses it under validation.
    // `approximate` is set only when a caret coexists with a non-caret key.
    // An all-caret set is distinct by construction and is accepted because
    // the builder normally compacts resolved MINT tickers to caret ids.
    if (mint.approximate)
        errors.push(validator._error('BATCH_CONSTRAINT',
            'BATCH mixes a `^<id>` MINT TICK with another MINT: a caret alias and a name can be the ' +
            'SAME token, which this SDK cannot resolve. Spell every MINT TICK by name.',
            { ticks: mintTicks.slice() }));
}

// Coordinates synchronous batch checks without changing their return shape.
function validateBatch(validator, fields) {
    let errors = [];
    if (validator.isEmpty(fields.COMMAND)) return errors;

    let commands = String(fields.COMMAND).split(';');
    if (!validateBatchEnvelope(validator, commands, errors)) return errors;
    const state = scanBatchCommands(validator, commands, errors);

    // MINT is capped per DISTINCT token, not per occurrence: minting twelve
    // different tokens in one transaction takes nothing from anyone, while a
    // batch of 100 MINTs of ONE fair-mint token beats 100 separate
    // transactions on both fee and in-block ordering.
    let mint = state.mintTicks.length
        ? maxMintsPerDistinctTick(state.mintTicks)
        : { max: 0, approximate: false };
    appendBatchLimits(validator, commands, state, mint, errors);
    appendMintAliasFinding(validator, mint, state.mintTicks, errors);
    if (state.fileCount > 1)
        errors.push(validator._error('BATCH_CONSTRAINT', 'BATCH can contain at most 1 FILE action (one rawData per transaction)', { count: state.fileCount }));
    return errors;
}

module.exports = { validateBatch };
