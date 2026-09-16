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

const {
    VALID_COINS,
} = require('./field_limits.js');

// Applies one contiguous field-rule group while preserving finding order.
function validateBridgeChains(validator, action, field, value, allFields, errors) {
    // ISSUE v7 bridge opt-in fields (the token bridge spec §7). Both names live on
    // that one format and nowhere else in formats.js, so neither needs an action gate.
    //
    // BRIDGE_CHAINS is the '-' sentinel (bridge nowhere) or a comma list of chain
    // coins. Mirrors xchain-indexer/src/actions/issue.js:862, which upper-cases each
    // comma segment and refuses the action when it is not in config['COINS']. It does
    // NOT trim, so ' LTC' is refused on chain and must be refused here too; trimming
    // would make the SDK looser than consensus and pay a miner fee to find out.
    //
    // The handler's other half of that rule, "and not THIS chain", is undecidable
    // here: the validator carries a network but no coin. src/preflight/checks/issue.js
    // owns that half, where the plane is known.
    //
    // An EMPTY value never reaches this branch (the caller skips empties), which is
    // the wire meaning the handler gives it: empty = unchanged.
    if (field === 'BRIDGE_CHAINS' && String(value) !== '-') {
        for (let chain of String(value).split(',')) {
            if (!VALID_COINS.includes(chain.toUpperCase())) {
                errors.push(validator._error('INVALID_FIELD_VALUE',
                    'BRIDGE_CHAINS must be "-" or a comma list of chain coins ('
                    + VALID_COINS.join(', ') + '), excluding this chain; "' + chain + '" is not one',
                    { field, value: chain, constraint: { valid: VALID_COINS } }));
                break;
            }
        }
    }
}

// Applies one contiguous field-rule group while preserving finding order.
function validateMinimumDepth(validator, action, field, value, allFields, errors) {
    // MIN_DEPTH is a raise-only confirmation depth: the federation honours
    // max(platform default, MIN_DEPTH), so 0 is "no raise" and a negative or
    // fractional value is meaningless. Digits only, mirroring
    // xchain-indexer/src/actions/issue.js:873 ('invalid: MIN_DEPTH (format)').
    if (field === 'MIN_DEPTH') {
        if (!/^[0-9]+$/.test(String(value)))
            errors.push(validator._error('INVALID_FIELD_VALUE',
                'MIN_DEPTH must be a whole number of confirmations (digits only)',
                { field, value }));
    }
}

// Applies one contiguous field-rule group while preserving finding order.
function validateNumericValue(validator, action, field, value, allFields, errors) {
    if (field === 'VALUE') {
        if (!validator.util.isNumeric(value))
            errors.push(validator._error('INVALID_FIELD_VALUE', 'VALUE must be numeric', { field, value }));
    }
}

// Applies one contiguous field-rule group while preserving finding order.
function validatePriceValue(validator, action, field, value, allFields, errors) {
    // VALUE validation (PRICE v1: the published token price in FIAT). Stricter
    // than the generic numeric check above and matched to the indexer's
    // 'invalid: VALUE (format)' rule: a positive decimal, at most 8 places.
    // A zero or negative price is not a price, and a 9th decimal is silently
    // unpublishable, so both are worth catching before the fee is spent.
    if (field === 'VALUE' && action === 'PRICE') {
        if (!/^[0-9]+(\.[0-9]{1,8})?$/.test(String(value)) || Number(value) <= 0)
            errors.push(validator._error('INVALID_FIELD_VALUE', 'VALUE must be a positive price with at most 8 decimal places', { field, value }));
    }
}

module.exports = { FIELD_VALIDATORS: [validateBridgeChains, validateMinimumDepth, validateNumericValue, validatePriceValue] };
