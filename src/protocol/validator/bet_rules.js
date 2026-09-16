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

// Loading the betting constants here is cycle-safe; decoder parsing remains
// deferred in the prototype part because it leads back to the validator.
const { BET_LIMITS } = require('../../actions/betting.js');

// Validates market labels together because they define the displayed outcomes.
function validateBetLabels(validator, fields, limits, errors) {
    // LABEL length. Presence is handled by ACTION_REQUIRED_FIELDS.
    if (!validator.isEmpty(fields.LABEL) && String(fields.LABEL).length > limits.MAX_BET_LABEL_LENGTH)
        errors.push(validator.buildError('INVALID_FIELD_VALUE',
            'LABEL must be ' + limits.MAX_BET_LABEL_LENGTH + ' characters or less',
            { field: 'LABEL', value: String(fields.LABEL).length, constraint: { max: limits.MAX_BET_LABEL_LENGTH } }));

    // OUTCOMES: 2..MAX entries, each non-empty, length-capped, and
    // byte-unique after trim. Case variants are legal, so not checked.
    if (!validator.isEmpty(fields.OUTCOMES)) {
        const labels = String(fields.OUTCOMES).split(',').map(o => o.trim());
        if (labels.length < 2 || labels.length > limits.MAX_BET_OUTCOMES)
            errors.push(validator.buildError('INVALID_FIELD_VALUE',
                'OUTCOMES must have between 2 and ' + limits.MAX_BET_OUTCOMES + ' comma-separated entries',
                { field: 'OUTCOMES', value: labels.length }));
        if (labels.some(l => l === ''))
            errors.push(validator.buildError('INVALID_FIELD_VALUE', 'OUTCOMES entries may not be empty', { field: 'OUTCOMES' }));
        if (labels.some(l => l.length > limits.MAX_BET_OUTCOME_LENGTH))
            errors.push(validator.buildError('INVALID_FIELD_VALUE',
                'each OUTCOMES entry must be ' + limits.MAX_BET_OUTCOME_LENGTH + ' characters or less',
                { field: 'OUTCOMES', constraint: { max: limits.MAX_BET_OUTCOME_LENGTH } }));
        if (new Set(labels).size !== labels.length)
            errors.push(validator.buildError('INVALID_FIELD_VALUE', 'OUTCOMES entries must be unique', { field: 'OUTCOMES' }));
    }

    // Betting is token-only: an empty TICK means native coin, which
    // cannot be escrowed at parse. Presence is required above, so this
    // only catches a whitespace-only tick.
    if (!validator.isEmpty(fields.TICK) && String(fields.TICK).trim() === '')
        errors.push(validator.buildError('INVALID_FIELD_VALUE',
            'TICK is required: betting is token-only and native coin is not supported',
            { field: 'TICK' }));
}

// Validates numeric market terms in their wire-field order.
function validateBetTerms(validator, fields, limits, errors) {
    // FEE is a PERCENT of the pot (1.00 = 1%), at most 2 decimals.
    if (!validator.isEmpty(fields.FEE)) {
        const fee = String(fields.FEE).trim();
        if (!/^\d+(\.\d{1,2})?$/.test(fee))
            errors.push(validator.buildError('INVALID_FIELD_VALUE',
                'FEE must be a non-negative number with at most 2 decimal places (a percent of the pot: 1.00 = 1%)',
                { field: 'FEE', value: fields.FEE }));
        else if (Number(fee) > limits.MAX_FEED_FEE)
            errors.push(validator.buildError('INVALID_FIELD_VALUE',
                'FEE must be at most ' + limits.MAX_FEED_FEE + ' percent',
                { field: 'FEE', value: fee, constraint: { max: limits.MAX_FEED_FEE } }));
    }

    // DEADLINE is a Unix timestamp. "In the future" is a block-time
    // question the indexer owns; only the shape is checked here.
    if (!validator.isEmpty(fields.DEADLINE)) {
        const dl = Number(fields.DEADLINE);
        if (!Number.isInteger(dl) || dl <= 0)
            errors.push(validator.buildError('INVALID_FIELD_VALUE',
                'DEADLINE must be a positive integer Unix timestamp',
                { field: 'DEADLINE', value: fields.DEADLINE }));
    }
    if (!validator.isEmpty(fields.REFUND_WINDOW)) {
        const rw = Number(fields.REFUND_WINDOW);
        if (!Number.isInteger(rw) || rw < limits.MIN_BET_REFUND_WINDOW || rw > limits.MAX_BET_REFUND_WINDOW)
            errors.push(validator.buildError('INVALID_FIELD_VALUE',
                'REFUND_WINDOW must be an integer between ' + limits.MIN_BET_REFUND_WINDOW +
                ' and ' + limits.MAX_BET_REFUND_WINDOW + ' seconds',
                { field: 'REFUND_WINDOW', value: fields.REFUND_WINDOW }));
    }
    if (!validator.isEmpty(fields.MIN_AMOUNT)) {
        if (!validator.util.isNumeric(fields.MIN_AMOUNT) || Number(fields.MIN_AMOUNT) <= 0)
            errors.push(validator.buildError('INVALID_FIELD_VALUE',
                'MIN_AMOUNT must be a positive amount',
                { field: 'MIN_AMOUNT', value: fields.MIN_AMOUNT }));
    }
}

// Applies list compatibility and structured details after scalar market terms.
function validateBetPolicy(validator, fields, limits, errors) {
    // The same list in both slots builds a market nobody can ever bet on.
    if (!validator.isEmpty(fields.ALLOW_LIST) && !validator.isEmpty(fields.BLOCK_LIST) &&
        String(fields.ALLOW_LIST).trim() === String(fields.BLOCK_LIST).trim())
        errors.push(validator.buildError('INVALID_FIELD_VALUE',
            'BLOCK_LIST must differ from ALLOW_LIST: the same list in both slots bars every address',
            { field: 'BLOCK_LIST', value: fields.BLOCK_LIST }));

    // DETAILS: strict base64 of a JSON object, size- and depth-capped,
    // with any `outcomes` key matching OUTCOMES byte-for-byte.
    if (!validator.isEmpty(fields.DETAILS))
        errors.push(...validator._validateBetDetails(String(fields.DETAILS), fields.OUTCOMES, limits));
}

// Validates lifecycle fields separately because they select cancel, resolve, or place.
function validateBetLifecycle(validator, fields, errors) {
    // Lifecycle formats. FEED_ACTION_INDEX is the market reference.
    if (!/^\d+$/.test(String(fields.FEED_ACTION_INDEX).trim()))
        errors.push(validator.buildError('INVALID_FIELD_VALUE',
            'FEED_ACTION_INDEX must be a numeric ACTION_INDEX',
            { field: 'FEED_ACTION_INDEX', value: fields.FEED_ACTION_INDEX }));

    // OUTCOME is a zero-based index. Its upper bound depends on the
    // market's outcome count, which is on-chain state, so only the
    // non-negative-integer shape is checkable here.
    if (!validator.isEmpty(fields.OUTCOME) || fields.OUTCOME === 0 || fields.OUTCOME === '0') {
        if (!/^\d+$/.test(String(fields.OUTCOME).trim()))
            errors.push(validator.buildError('INVALID_FIELD_VALUE',
                'OUTCOME must be a zero-based integer index into the market OUTCOMES',
                { field: 'OUTCOME', value: fields.OUTCOME }));
    }
    if (!validator.isEmpty(fields.AMOUNT)) {
        if (!validator.util.isNumeric(fields.AMOUNT) || Number(fields.AMOUNT) <= 0)
            errors.push(validator.buildError('INVALID_FIELD_VALUE',
                'AMOUNT must be a positive stake',
                { field: 'AMOUNT', value: fields.AMOUNT }));
    }

    // A place-bet needs an outcome to stake on. Without this an AMOUNT
    // with no OUTCOME selects format 1 (cancel) and silently becomes a
    // different action than the caller meant.
    if (!validator.isEmpty(fields.AMOUNT) && validator.isEmpty(fields.OUTCOME) &&
        fields.OUTCOME !== 0 && fields.OUTCOME !== '0')
        errors.push(validator.buildError('MISSING_REQUIRED_FIELD',
            'BET place-bet requires OUTCOME alongside AMOUNT',
            { field: 'OUTCOME' }));
}

// Coordinates synchronous BET branches while retaining their result order.
function validateBet(validator, fields) {
    let errors = [];
    const limits = BET_LIMITS;
    const isCreate = validator.isEmpty(fields.FEED_ACTION_INDEX);
    if (isCreate) {
        validateBetLabels(validator, fields, limits, errors);
        validateBetTerms(validator, fields, limits, errors);
        validateBetPolicy(validator, fields, limits, errors);
    } else {
        validateBetLifecycle(validator, fields, errors);
    }
    return errors;
}

module.exports = { validateBet };
