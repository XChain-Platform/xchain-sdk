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

// Parses strict DETAILS input and returns null after any terminal format error.
function parseBetDetails(validator, details, limits, errors) {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(details) || details.length % 4 !== 0) {
        errors.push(validator._error('INVALID_FIELD_VALUE',
            'DETAILS must be strict base64 (A-Za-z0-9+/ with = padding, length a multiple of 4)',
            { field: 'DETAILS' }));
        return null;
    }
    const buf = Buffer.from(details, 'base64');
    if (buf.toString('base64') !== details) {
        errors.push(validator._error('INVALID_FIELD_VALUE',
            'DETAILS is not canonical base64: it does not re-encode to itself',
            { field: 'DETAILS' }));
        return null;
    }
    if (buf.length > limits.MAX_BET_DETAILS_LENGTH) {
        errors.push(validator._error('INVALID_FIELD_VALUE',
            'DETAILS decodes to ' + buf.length + ' bytes, max ' + limits.MAX_BET_DETAILS_LENGTH,
            { field: 'DETAILS', value: buf.length, constraint: { max: limits.MAX_BET_DETAILS_LENGTH } }));
        return null;
    }

    let parsed;
    try {
        parsed = JSON.parse(buf.toString('utf8'));
    } catch (e) {
        errors.push(validator._error('INVALID_FIELD_VALUE', 'DETAILS must decode to parseable JSON', { field: 'DETAILS' }));
        return null;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        errors.push(validator._error('INVALID_FIELD_VALUE',
            'DETAILS must decode to a JSON object, not an array or a bare value',
            { field: 'DETAILS' }));
        return null;
    }
    return parsed;
}

// Measures object nesting recursively because the encoded payload is hostile input.
function detailsDepth(value, level) {
    if (value === null || typeof value !== 'object') return level;
    let max = level;
    for (const key of Object.keys(value)) max = Math.max(max, detailsDepth(value[key], level + 1));
    return max;
}

// Checks DETAILS outcomes last so earlier depth findings keep their precedence.
function validateDetailsOutcomes(validator, parsed, outcomes, errors) {
    // The cross-check that stops a market's human-readable outcomes drifting
    // from the ones bets are actually settled against.
    if (parsed.outcomes !== undefined && !validator.isEmpty(outcomes)) {
        const canonical = String(outcomes).split(',').map(o => o.trim());
        if (!Array.isArray(parsed.outcomes)) {
            errors.push(validator._error('INVALID_FIELD_VALUE',
                'DETAILS.outcomes must be an array when present', { field: 'DETAILS' }));
        } else {
            const given = parsed.outcomes.map(o => String(o == null ? '' : o).trim());
            if (given.length !== canonical.length || given.some((o, i) => o !== canonical[i]))
                errors.push(validator._error('INVALID_FIELD_VALUE',
                    'DETAILS.outcomes must match the OUTCOMES field exactly (same order, same count)',
                    { field: 'DETAILS', outcomes: canonical, details: given }));
        }
    }
}

// Coordinates strict parsing, depth, and outcome checks without adding async work.
function validateBetDetails(validator, details, outcomes, limits) {
    let errors = [];
    const parsed = parseBetDetails(validator, details, limits, errors);
    if (parsed === null) return errors;

    const depth = detailsDepth(parsed, 1);
    if (depth > limits.MAX_BET_DETAILS_DEPTH)
        errors.push(validator._error('INVALID_FIELD_VALUE',
            'DETAILS nests ' + depth + ' levels deep, max ' + limits.MAX_BET_DETAILS_DEPTH,
            { field: 'DETAILS', value: depth, constraint: { max: limits.MAX_BET_DETAILS_DEPTH } }));
    validateDetailsOutcomes(validator, parsed, outcomes, errors);
    return errors;
}

module.exports = { validateBetDetails };
