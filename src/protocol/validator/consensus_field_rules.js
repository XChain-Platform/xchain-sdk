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
 * Stateless field rules the indexer enforces on the wire value alone: text
 * caps, well-formed UTF-16, amount precision and sign, integer-only fields and
 * the PRICE v1 canonical value. Each rule names the indexer source it mirrors,
 * so a change there has one obvious place to land here.
 *
 ********************************************************************/

'use strict';

const gateRegistry = require('../../consensus/gate_registry.js');
const { FULL_NAME_TO_TICK } = require('../../coins/index.js');
const { PRICE_MAX } = require('../constants.js');
const {
    MAX_DECIMALS,
    MAX_TICK_LENGTH,
    MAX_MEMO_LENGTH,
    MAX_MESSAGE_LENGTH,
    MAX_BROADCAST_MESSAGE_LENGTH,
    MAX_BROADCAST_VALUE_LENGTH,
    MAX_FILE_NAME_LENGTH,
    MAX_FILE_TYPE_LENGTH,
    MAX_FILE_TITLE_LENGTH,
} = require('./field_limits.js');

const PRICE_V1_CANONICAL_GATE = 'price_scale_activation.PRICE_V1_CANONICAL_ACTIVATION';
const PRICE_V1_VALUE_MAX_LENGTH = gateRegistry.copy('price_scale_activation.PRICE_V1_VALUE_MAX_LENGTH');
const PRICE_V1_FEE_MAX_LENGTH = gateRegistry.copy('price_scale_activation.PRICE_V1_FEE_MAX_LENGTH');
const PRICE_VALUE_RE_CANONICAL = gateRegistry.copy('price_scale_activation.PRICE_VALUE_RE_CANONICAL');
const PRICE_V1_FEE_RE_CANONICAL = gateRegistry.copy('price_scale_activation.PRICE_V1_FEE_RE_CANONICAL');

// Fields whose fraction is measured against a token row's DECIMALS on chain, which
// never exceeds MAX_DECIMALS, so more fractional digits than that fail at any tick.
// Keyed by field, then the actions where the indexer runs isValidAmountFormat on it.
const TOKEN_PRECISION_FIELDS = {
    AMOUNT:          new Set(['SEND', 'MINT', 'DESTROY', 'AIRDROP', 'DIVIDEND', 'XBRIDGE']),
    GIVE_AMOUNT:     new Set(['ORDER', 'SWAP', 'DISPENSER']),
    GET_AMOUNT:      new Set(['ORDER', 'SWAP', 'DISPENSER']),
    // A CALLBACK_TICK with no row is measured at 0 decimals, never NaN.
    CALLBACK_AMOUNT: new Set(['ISSUE']),
};

// ISSUE's AMOUNT-class fields beside MAX_SUPPLY, which has its own rule
// (xchain-indexer/src/actions/issue/index.js fieldList['AMOUNT']).
const ISSUE_AMOUNT_FIELDS = new Set(['MAX_MINT', 'MINT_SUPPLY', 'MINT_ADDRESS_MAX',
    'MINT_START_BLOCK', 'MINT_STOP_BLOCK', 'CALLBACK_AMOUNT']);

function fractionDigits(value) {
    const parts = String(value).split('.');
    return parts.length === 2 ? parts[1].length : 0;
}

// A lone surrogate cannot be encoded as UTF-8, so the carrier writes U+FFFD in its
// place and the chain records text the caller never wrote. LIST metadata carries the
// same refusal inside its own grammar (list_meta_rules.js), and BATCH COMMAND is
// judged command by command, so both are left to those rules.
function validateWellFormedText(validator, action, field, value, allFields, errors) {
    if (field === 'COMMAND' || (action === 'LIST' && (field === 'NAME' || field === 'DESCRIPTION')))
        return;
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
        if (typeof item === 'string' && !item.isWellFormed()) {
            errors.push(validator.buildError('INVALID_FIELD_VALUE',
                field + ' contains an unpaired UTF-16 surrogate, which the wire cannot carry '
                + '(it would be recorded as U+FFFD)', { field }));
            return;
        }
    }
}

function pushTooLong(validator, errors, field, value, max) {
    if (String(value).length > max)
        errors.push(validator.buildError('INVALID_FIELD_VALUE',
            field + ' must be ' + max + ' characters or less (UTF-16 code units)',
            { field, value: String(value).length, constraint: { max } }));
}

// MEMO is capped at MAX_MEMO_LENGTH by every action that checks it, except two:
// PRICE v1 stores it unchecked (actions/price/v1.js) and VOTE bounds it by
// MAX_MESSAGE_LENGTH (actions/vote/index.js). Multi-leg MEMOs are checked per leg,
// and the indexer refuses that leg alone, which the per-leg pass here reports.
function validateTextLengths(validator, action, field, value, allFields, errors) {
    if (field === 'MEMO' && action !== 'PRICE')
        pushTooLong(validator, errors, field, value, action === 'VOTE' ? MAX_MESSAGE_LENGTH : MAX_MEMO_LENGTH);
    if (action === 'BROADCAST' && field === 'MESSAGE')
        pushTooLong(validator, errors, field, value, MAX_BROADCAST_MESSAGE_LENGTH);
    if (action === 'BROADCAST' && field === 'VALUE')
        pushTooLong(validator, errors, field, value, MAX_BROADCAST_VALUE_LENGTH);
    if (action === 'FILE' && field === 'NAME')
        pushTooLong(validator, errors, field, value, MAX_FILE_NAME_LENGTH);
    if (action === 'FILE' && field === 'TYPE')
        pushTooLong(validator, errors, field, value, MAX_FILE_TYPE_LENGTH);
    if (action === 'FILE' && field === 'TITLE')
        pushTooLong(validator, errors, field, value, MAX_FILE_TITLE_LENGTH);
}

// Precision and sign rules from utility/validation/amount_validation.js
// isValidAmountFormat, limited to what holds without the token row.
function validateAmountPrecision(validator, action, field, value, allFields, errors) {
    const capped = TOKEN_PRECISION_FIELDS[field];
    if (capped && capped.has(action) && fractionDigits(value) > MAX_DECIMALS)
        errors.push(validator.buildError('INVALID_FIELD_VALUE',
            field + ' cannot carry more than ' + MAX_DECIMALS + ' fractional digits',
            { field, value, constraint: { maxFractionalDigits: MAX_DECIMALS } }));
    if (action !== 'ISSUE' || !ISSUE_AMOUNT_FIELDS.has(field)) return;
    validateIssueBlockFraction(validator, field, value, errors);
    if (String(value).startsWith('-'))
        errors.push(validator.buildError('INVALID_FIELD_VALUE', field + ' cannot be negative', { field, value }));
    // With DECIMALS on the wire the effective precision is the row's or the wire's,
    // both capped at MAX_DECIMALS. Without it, an existing tick uses its row and a new
    // one resolves NaN decimals; what the chain does with NaN depends on the amount
    // representability gate (below it no cap, at or above it the amount is refused,
    // e.g. ISSUE|NEWTOK|1000 as 'MAX_SUPPLY (format)'), and whether the tick exists
    // is chain state, so nothing is asserted here.
    else if (field !== 'CALLBACK_AMOUNT' && !validator.isEmpty(allFields && allFields.DECIMALS)
        && fractionDigits(value) > MAX_DECIMALS)
        errors.push(validator.buildError('INVALID_FIELD_VALUE',
            field + ' cannot carry more than ' + MAX_DECIMALS + ' fractional digits', { field, value }));
}

// The mint window is measured in blocks, yet the chain judges MINT_START_BLOCK and
// MINT_STOP_BLOCK with the tick's amount format (issue/index.js fieldList['AMOUNT']),
// so a fraction is refused only on a tick with 0 decimals and stored on any other.
// Refusing every fraction is therefore a user-protection guard (a half block names no
// block), tagged sdkGuard so the decoder's verdict stays the chain's.
function validateIssueBlockFraction(validator, field, value, errors) {
    if ((field === 'MINT_START_BLOCK' || field === 'MINT_STOP_BLOCK') && String(value).includes('.'))
        errors.push(validator.buildError('INVALID_FIELD_VALUE', field + ' must be a whole block number',
            { field, value, sdkGuard: true }));
}

// The capability STAKE formats (v1/v2) take an 8-decimal amount
// (actions/stake/capability_stake.js); v3 is measured against its token's row.
function validateStakeAmount(validator, action, field, value, allFields, errors) {
    if (action !== 'STAKE' || field !== 'AMOUNT') return;
    const version = validator.isEmpty(allFields && allFields.VERSION) ? null : Number(allFields.VERSION);
    const capability = version === 1 || version === 2
        || (version === null && validator.isEmpty(allFields && allFields.TARGET_CONTRACT_INDEX));
    if (capability && !/^[0-9]+(\.[0-9]{1,8})?$/.test(String(value)))
        errors.push(validator.buildError('INVALID_FIELD_VALUE',
            'STAKE AMOUNT must be a plain decimal with at most 8 decimal places', { field, value }));
}

// Integer-only fields the generic numeric rules let a fraction through.
function validateIntegerFields(validator, action, field, value, allFields, errors) {
    // ORDER/SWAP/DISPENSER EXPIRATION (actions/order/validate.js and its siblings).
    if (field === 'EXPIRATION' && (!validator.util.isNumeric(value) || !Number.isInteger(Number(value))))
        errors.push(validator.buildError('INVALID_FIELD_VALUE', 'EXPIRATION must be an integer', { field, value }));
    // ADDRESS REQUIRE_MEMO takes 0 or 1 (actions/address.js validValues).
    if (action === 'ADDRESS' && field === 'REQUIRE_MEMO' && ![0, 1].includes(Number(value)))
        errors.push(validator.buildError('INVALID_FIELD_VALUE', 'REQUIRE_MEMO must be 0 or 1', { field, value, constraint: { valid: [0, 1] } }));
}

// The validator's network as the registry keys it, { network, coin }. The coin is
// known only from a chain-id spelling ('bitcoin-regtest'); a bare tier gives null.
function networkPlane(validator) {
    const [first, plane] = String(validator.network || '').toLowerCase().split('-');
    const network = plane || first;
    return {
        network: ['mainnet', 'testnet', 'regtest'].includes(network) ? network : null,
        coin: plane ? FULL_NAME_TO_TICK[first] || null : null,
    };
}

// Whether the PRICE v1 canonical-form gate binds for an action composed now on the
// validator's network. An unresolved network answers false, the permissive side.
function priceV1CanonicalNow(validator) {
    const { network, coin } = networkPlane(validator);
    if (network === null) return false;
    try {
        return gateRegistry.activeAt(PRICE_V1_CANONICAL_GATE, network, coin, null, Math.floor(Date.now() / 1000)) === true;
    } catch (e) {
        return false;
    }
}

// PRICE v1 rules from actions/price/v1.js. The TICK bound is unconditional; the
// canonical VALUE/FEE spelling and the VALUE ceiling bind behind time gates. The
// ceiling's own gate (price_zero_validity_activation) has no row in this SDK's
// registry; it is armed on testnet and regtest and inert on mainnet, the same
// planes the canonical gate is armed on today, so it rides that gate here.
function validatePriceV1(validator, action, field, value, allFields, errors) {
    if (action !== 'PRICE') return;
    const text = String(value);
    if (field === 'TICK' && text.length > MAX_TICK_LENGTH)
        errors.push(validator.buildError('INVALID_FIELD_VALUE', 'PRICE TICK must be 1-' + MAX_TICK_LENGTH + ' characters', { field, value: text.length }));
    if ((field !== 'VALUE' && field !== 'FEE') || !priceV1CanonicalNow(validator)) return;
    if (field === 'VALUE' && (text.length > PRICE_V1_VALUE_MAX_LENGTH || !PRICE_VALUE_RE_CANONICAL.test(text)))
        errors.push(validator.buildError('INVALID_FIELD_VALUE',
            'VALUE must be canonical (no leading zero) and at most ' + PRICE_V1_VALUE_MAX_LENGTH + ' characters', { field, value }));
    else if (field === 'VALUE' && !(parseFloat(text) < PRICE_MAX))
        errors.push(validator.buildError('INVALID_FIELD_VALUE', 'VALUE must be below ' + PRICE_MAX, { field, value }));
    if (field === 'FEE' && (text.length > PRICE_V1_FEE_MAX_LENGTH || !PRICE_V1_FEE_RE_CANONICAL.test(text)))
        errors.push(validator.buildError('INVALID_FIELD_VALUE',
            'FEE must be canonical (no leading zero) and at most ' + PRICE_V1_FEE_MAX_LENGTH + ' characters', { field, value }));
}

module.exports = {
    networkPlane,
    FIELD_VALIDATORS: [validateWellFormedText, validateTextLengths, validateAmountPrecision,
        validateStakeAmount, validateIntegerFields, validatePriceV1],
};
