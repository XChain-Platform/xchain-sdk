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
    MAX_MESSAGE_LENGTH,
    MAX_GATE_MIN_AMOUNT_LENGTH,
} = require('./field_limits.js');

// Applies one contiguous field-rule group while preserving finding order.
function validateFileKeyHash(validator, action, field, value, allFields, errors) {
    // FILE v1 gated-content fields
    // The /i is deliberate and mirrors consensus: xchain-indexer accepts either
    // case and records the lowercase form, so tightening this to lowercase-only
    // would make the decoder's advisory findings disagree with chain validity on
    // FILEs the chain accepted, and would contradict gatedFile.verifyKey, which
    // lowercases a supplied KEY_HASH before comparing. Producers still emit
    // lowercase (generateKey uses digest('hex')); the message says so rather than
    // asserting a rule this check does not enforce.
    if (action === 'FILE' && field === 'KEY_HASH') {
        if (value !== '' && !/^[0-9a-f]{64}$/i.test(String(value)))
            errors.push(validator._error('INVALID_FIELD_VALUE',
                'KEY_HASH must be 64 hex characters, sha256(K); emit it lowercase, ' +
                'the chain accepts either case and records the lowercase form',
                { field, value }));
    }
}

// Applies one contiguous field-rule group while preserving finding order.
function validateFileGateTicker(validator, action, field, value, allFields, errors) {
    if (action === 'FILE' && field === 'GATE_TICKER') {
        // Empty is allowed (= public file); when set, basic TICK constraints apply.
        if (value !== '' && /[|;./]/.test(String(value)))
            errors.push(validator._error('INVALID_FIELD_VALUE',
                'GATE_TICKER cannot contain |, ;, ., or /',
                { field, value }));
    }
}

// Applies one contiguous field-rule group while preserving finding order.
function validateFileGateMinAmount(validator, action, field, value, allFields, errors) {
    // GATE_MIN_AMOUNT is the unlock threshold defined by the file specification.
    //
    // STATELESS checks only. Divisibility is deliberately NOT checked here: the
    // bound is min(the gate tick's divisibility, THRESHOLD_SCALE), and a tick's
    // divisibility is chain STATE at the FILE's block, which this validator does
    // not have and must not guess at. The indexer is the arbiter for that half;
    // duplicating a state-dependent rule here would only create a second, weaker
    // opinion that disagrees at the boundary.
    //
    // Every rule below is a FORMAT rule, and each one exists because the value is
    // consensus-visible and lands in a VARCHAR(40) column:
    //   - strictly greater than zero: a zero threshold is not "no threshold", it
    //     is a threshold nobody can fail, so every zero form is rejected rather
    //     than silently meaning something different from an absent field
    //   - digits and at most one '.', no sign characters: keeps it pipe-free and
    //     unambiguous on the wire, and rules out '+1'/'-1'/'1e3' style forms
    //   - no leading zeros unless the integer part is exactly '0': one value must
    //     have one spelling, or two byte-different FILEs mean the same threshold
    //   - non-empty fractional part when '.' is present: '1.' is not a number
    //   - at most 40 characters: consensus validity must never depend on what a
    //     DB does to an oversized value (the column would truncate it)
    if (action === 'FILE' && field === 'GATE_MIN_AMOUNT') {
        const raw = String(value);
        if (raw !== '') {
            const bad = (msg, extra) => errors.push(validator._error('INVALID_FIELD_VALUE',
                'GATE_MIN_AMOUNT ' + msg, Object.assign({ field, value }, extra || {})));
            if (raw.length > MAX_GATE_MIN_AMOUNT_LENGTH) {
                bad('must be at most ' + MAX_GATE_MIN_AMOUNT_LENGTH + ' characters',
                    { constraint: { maxLength: MAX_GATE_MIN_AMOUNT_LENGTH } });
            } else if (!/^\d+(\.\d+)?$/.test(raw)) {
                // Covers the sign, exponent, bare-point, empty-fraction and
                // multiple-point cases in one pass.
                bad('must be a decimal amount: digits with at most one "." and a ' +
                    'non-empty fractional part, no sign or exponent');
            } else if (/^0\d/.test(raw)) {
                bad('must not have leading zeros in the integer part');
            } else if (!/[1-9]/.test(raw)) {
                // Every zero spelling: 0, 0.0, 0.000. Checked after shape so the
                // message is about the value rather than the syntax.
                bad('must be strictly greater than zero (omit the field for no threshold)');
            }
        }
    }
}

// Applies one contiguous field-rule group while preserving finding order.
function validateMessageFields(validator, action, field, value, allFields, errors) {
    // FILE NAME/TYPE/TITLE delimiter safety is handled by _checkDelimiters.

    // MESSAGE content length validation (delimiter safety via _checkDelimiters)
    if (field === 'PLAINTEXT_MESSAGE' || field === 'ENCRYPTED_MESSAGE' || field === 'ENCRYPTION_KEY') {
        if (String(value).length > MAX_MESSAGE_LENGTH)
            errors.push(validator._error('INVALID_FIELD_VALUE', field + ' must be ' + MAX_MESSAGE_LENGTH + ' characters or less', { field, value: String(value).length, constraint: { max: MAX_MESSAGE_LENGTH } }));
    }
}

// Applies one contiguous field-rule group while preserving finding order.
function validateFeePreference(validator, action, field, value, allFields, errors) {
    // FEE_PREFERENCE validation (ADDRESS action)
    if (field === 'FEE_PREFERENCE') {
        if (!validator.util.isValidValue(value, [1, 2, 3]))
            errors.push(validator._error('INVALID_FIELD_VALUE', 'FEE_PREFERENCE must be 1 (destroy), 2 (protocol), or 3 (community)', { field, value, constraint: { valid: [1, 2, 3] } }));
    }
}

// Applies one contiguous field-rule group while preserving finding order.
function validateDispenserPreference(validator, action, field, value, allFields, errors) {
    // DISPENSER_PREFERENCE validation (ADDRESS action): who may open dispensers on this address
    if (field === 'DISPENSER_PREFERENCE') {
        if (!validator.util.isValidValue(value, [1, 2]))
            errors.push(validator._error('INVALID_FIELD_VALUE', 'DISPENSER_PREFERENCE must be 1 (owner only) or 2 (anyone)', { field, value, constraint: { valid: [1, 2] } }));
    }
}

// Applies one contiguous field-rule group while preserving finding order.
function validateListType(validator, action, field, value, allFields, errors) {
    if (field === 'TYPE' && action === 'LIST') {
        if (!validator.util.isValidValue(value, [1, 2]))
            errors.push(validator._error('INVALID_FIELD_VALUE', 'LIST TYPE must be 1 (TICK list) or 2 (ADDRESS list)', { field, value, constraint: { valid: [1, 2] } }));
    }
}

// Applies one contiguous field-rule group while preserving finding order.
function validateListEdit(validator, action, field, value, allFields, errors) {
    // LIST ITEM (rest-field), VOTE free-text fields, and ALLOW_LIST/BLOCK_LIST
    // delimiter safety are all handled by the default-deny _checkDelimiters guard
    // (which iterates array/rest values element-by-element).

    if (field === 'EDIT') {
        if (!validator.util.isValidValue(value, [1, 2]))
            errors.push(validator._error('INVALID_FIELD_VALUE', 'EDIT must be 1 (ADD) or 2 (REMOVE)', { field, value, constraint: { valid: [1, 2] } }));
    }
}

// Applies one contiguous field-rule group while preserving finding order.
function validateBinaryFlags(validator, action, field, value, allFields, errors) {
    // Binary 0/1 flag fields
    // - SWEEP:               BALANCES / OWNERSHIPS / ORDERS / SWAPS / DISPENSERS
    // - ORDER / SWAP / DISPENSER: GIVE_OWNERSHIP / GET_OWNERSHIP
    if (field === 'BALANCES' || field === 'OWNERSHIPS' ||
        field === 'ORDERS'   || field === 'SWAPS'      || field === 'DISPENSERS' ||
        field === 'GIVE_OWNERSHIP' || field === 'GET_OWNERSHIP') {
        if (!validator.util.isValidLockValue(value))
            errors.push(validator._error('INVALID_FIELD_VALUE', field + ' must be 0 or 1', { field, value, constraint: { valid: [0, 1] } }));
    }
}

// Applies one contiguous field-rule group while preserving finding order.
function validateNumericAmounts(validator, action, field, value, allFields, errors) {
    // AMOUNT validation: all listed fields must be numeric.
    if (field === 'AMOUNT' || field === 'GIVE_AMOUNT' || field === 'GET_AMOUNT' ||
        field === 'GIVE_ESCROW' || field === 'CALLBACK_AMOUNT' ||
        field === 'MINT_SUPPLY' || field === 'MAX_MINT' || field === 'MINT_ADDRESS_MAX') {
        if (!validator.util.isNumeric(value))
            errors.push(validator._error('INVALID_FIELD_VALUE', field + ' must be numeric', { field, value }));
    }
}

// Applies one contiguous field-rule group while preserving finding order.
function validatePositiveAmounts(validator, action, field, value, allFields, errors) {
    // Spend/transfer amounts must additionally be positive: zero or negative
    // produces a transaction the indexer rejects (e.g. STAKE/SEND require >0),
    // so fail client-side rather than emit a doomed action. The supply-cap
    // fields above legitimately accept 0 (disabled) and so are excluded here.
    //
    // ONE EXCEPTION, and it is the protocol's own convention rather than a
    // loophole: a FIAT-priced DISPENSER carries GET_AMOUNT 0. Its coin price
    // is not stored at all, it is derived at settlement from FIAT_AMOUNT and
    // the validator price snapshot (DISPENSER.md examples 4/5;
    // xchain-indexer dispense.js says so outright - "the GET_AMOUNT of 0
    // that FIAT dispensers carry by convention"). The indexer checks only
    // GET_AMOUNT's FORMAT for a DISPENSER and never its sign, so refusing a
    // zero here was strictly stricter than the chain, and the effect was
    // total: neither pricing mode could be composed, so the whole
    // fiat/oracle dispenser feature was unreachable through any client
    // using this validator - including the wallet's own Advanced options
    // panel, which offers it. A fiat dispenser integration case could
    // not get past the form.
    // Exactly ZERO, not merely non-positive: the convention is a zero
    // placeholder standing in for "derived later", and a negative price is
    // nonsense in either pricing mode. A focused unit case prevents -1
    // from passing this exception.
    const fiatPricedDispenser = action === 'DISPENSER' && field === 'GET_AMOUNT'
        && Number(value) === 0
        && (!validator._isEmpty(allFields?.FIAT_CODE) || !validator._isEmpty(allFields?.ORACLE_ADDRESS));
    if (field === 'AMOUNT' || field === 'GIVE_AMOUNT' || field === 'GET_AMOUNT' ||
        field === 'GIVE_ESCROW' || field === 'CALLBACK_AMOUNT') {
        if (!fiatPricedDispenser && validator.util.isNumeric(value) && Number(value) <= 0)
            errors.push(validator._error('INVALID_FIELD_VALUE', field + ' must be a positive number', { field, value }));
    }
}

// Applies one contiguous field-rule group while preserving finding order.
function validateBroadcastFee(validator, action, field, value, allFields, errors) {
    // FEE validation (BROADCAST, percentage format)
    if (field === 'FEE' && action === 'BROADCAST') {
        if (!validator.util.isNumeric(value))
            errors.push(validator._error('INVALID_FIELD_VALUE', 'FEE must be numeric (percentage)', { field, value }));
    }
}

// Applies one contiguous field-rule group while preserving finding order.
function validatePriceFee(validator, action, field, value, allFields, errors) {
    // FEE validation (PRICE v1: the oracle usage fee a dispenser opener pays
    // this oracle, expressed as a fraction, 0.01 = 1%). Mirrors the indexer's
    // consensus rule: optional, up to 18 decimals, 0 <= FEE <= 1.
    //
    // The upper bound compares as an EXACT decimal (bcnum, the same
    // arbitrary-precision family the indexer's bcgt uses), never as a JS
    // double. The regex admits 18 decimals, and Number('1.000000000000000001')
    // rounds to exactly 1, so a `Number(value) > 1` gate certified a value the
    // indexer's bcgt(V1_FEE,'1') rejects: the client signed and paid for an
    // action that lands `invalid: FEE (format)` on-chain, forfeiting the fee.
    // The regex already forbids a leading '-', so the indexer's companion
    // lower bound needs no mirror here.
    if (field === 'FEE' && action === 'PRICE' && String(value).length > 0) {
        if (!/^[0-9]+(\.[0-9]{1,18})?$/.test(String(value)) || validator.util.bcnum(String(value)).gt('1'))
            errors.push(validator._error('INVALID_FIELD_VALUE', 'FEE must be a fraction between 0 and 1 with at most 18 decimals', { field, value, constraint: { min: 0, max: 1 } }));
    }
}

module.exports = { FIELD_VALIDATORS: [validateFileKeyHash, validateFileGateTicker, validateFileGateMinAmount, validateMessageFields, validateFeePreference, validateDispenserPreference, validateListType, validateListEdit, validateBinaryFlags, validateNumericAmounts, validatePositiveAmounts, validateBroadcastFee, validatePriceFee] };
