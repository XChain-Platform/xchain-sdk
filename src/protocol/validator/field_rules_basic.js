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
    ADDRESS_REF_FIELD_SET,
    MAX_SUPPLY_CEILING,
    MAX_DECIMALS,
    MAX_DESC_LENGTH,
    VALID_FIAT_CODES,
    VALID_COINS,
} = require('./field_limits.js');

// Applies one contiguous field-rule group while preserving finding order.
function validateTickFields(validator, action, field, value, allFields, errors) {
    if (field === 'TICK' || field === 'GIVE_TICK' || field === 'GET_TICK' ||
        field === 'DIVIDEND_TICK' || field === 'CALLBACK_TICK') {
        if (action === 'ISSUE' && field === 'TICK') {
            // Full TICK validation on ISSUE. A caret-led value is an id
            // reference rather than a name and is judged as one (see
            // validateTickName's first branch).
            errors.push(...validator.validateTickName(value, allFields));
        } else if (String(value).startsWith('^')) {
            // TICK_ID reference (^123), only valid outside of ISSUE. A delimiter
            // inside the id is already fatal here: isNumeric tests the WHOLE
            // remainder, so '^1|memo' fails as a non-numeric id.
            let id = String(value).substring(1);
            if (!validator.util.isNumeric(id))
                errors.push(validator._error('INVALID_TICK_ID', field + ' ID reference must be numeric: ' + value, { field, value }));
        } else {
            // An ordinary ticker name on a non-ISSUE action: the branch that had
            // nothing. These five fields are on DELIMITER_EXEMPT_FIELDS on the
            // stated grounds that they carry their own delimiter validation, which
            // was true of the two branches above and of nothing else, so
            // TICK='TOKEN|100|^1|memo' validated clean and serialized to
            // SEND|0|TOKEN|100|^1|memo|1|^2 - a wire string whose v0 parser reads
            // an injected amount and destination, and a ';' here injects a whole
            // BATCH sub-command.
            //
            // Delimiters only, deliberately: full validateTickName on a non-ISSUE
            // reference would make the SDK stricter than consensus and refuse tick
            // names that already exist on chain (the regression the FIAT_AMOUNT note
            // below records shipping once). '|' and ';' are outside TICK_REGEX
            // anyway, so nothing legitimate loses.
            errors.push(...validator.scanDelimiters(field, value));
        }
    }
}

// Applies one contiguous field-rule group while preserving finding order.
function validateDescriptionField(validator, action, field, value, allFields, errors) {
    // MEMO delimiter safety is handled by the default-deny checkDelimiters guard.

    // DESCRIPTION validation (delimiter safety via checkDelimiters)
    if (field === 'DESCRIPTION') {
        if (String(value).length > MAX_DESC_LENGTH)
            errors.push(validator._error('INVALID_FIELD_VALUE', 'DESCRIPTION must be ' + MAX_DESC_LENGTH + ' characters or less', { field, value: String(value).length, constraint: { max: MAX_DESC_LENGTH } }));
    }
}

// Applies one contiguous field-rule group while preserving finding order.
function validateDecimalsField(validator, action, field, value, allFields, errors) {
    if (field === 'DECIMALS') {
        if (!Number.isInteger(Number(value)) || Number(value) < 0 || Number(value) > MAX_DECIMALS)
            errors.push(validator._error('INVALID_FIELD_VALUE', 'DECIMALS must be an integer between 0 and ' + MAX_DECIMALS, { field, value, constraint: { min: 0, max: MAX_DECIMALS, type: 'integer' } }));
    }
}

// Applies one contiguous field-rule group while preserving finding order.
function validateMaxSupplyField(validator, action, field, value, allFields, errors) {
    // MAX_SUPPLY validation (use BigInt to avoid precision loss with large numbers)
    if (field === 'MAX_SUPPLY') {
        try {
            // The sign is read from the ORIGINAL string, because split('.') truncates
            // before the bound is applied: '-0.5' left the integer segment '-0', and
            // BigInt('-0') is 0n, so a negative supply cleared `bigVal < 0n` and was
            // serialized into an ISSUE the indexer then refuses (its amount-format
            // validator rejects any amount starting with '-') after the fee is spent.
            // Positive-fraction handling is deliberately untouched.
            let raw    = String(value).trim();
            let bigVal = BigInt(raw.split('.')[0]);
            if (raw.startsWith('-') || bigVal < 0n || bigVal > BigInt('1000000000000000000000'))
                errors.push(validator._error('INVALID_FIELD_VALUE', 'MAX_SUPPLY must be between 0 and ' + MAX_SUPPLY_CEILING, { field, value, constraint: { min: 0, max: MAX_SUPPLY_CEILING } }));
        } catch (e) {
            errors.push(validator._error('INVALID_FIELD_VALUE', 'MAX_SUPPLY must be numeric', { field, value }));
        }
        // Fractional precision, which the ceiling check above structurally cannot see: it
        // range-checks split('.')[0] and throws the fraction away, so MAX_SUPPLY=1.5 with
        // DECIMALS=0 cleared the SDK while the indexer refuses it as
        // 'invalid: MAX_SUPPLY (format)' (issue.js fieldList['AMOUNT'] -> isValidAmountFormat)
        // after the miner fee is already spent.
        //
        // Only the part decidable OFFLINE is decided here. issue.js:258 resolves
        // tick_decimals from the TOKEN ROW and falls back to the wire DECIMALS only when the
        // row carries none, so the wire value is NOT the tick's decimals on a re-issue:
        // keying the check to it rejects an 8-decimal token re-issued with a stale
        // DECIMALS=0 and MAX_SUPPLY=1000.5, which consensus accepts. That is the
        // SDK-stricter-than-consensus regression the FIAT_AMOUNT note below records having
        // shipped once already. The row-aware check lives where the row is readable:
        // preflight/checks/issue.js, which resolves the same decimals the indexer does.
        //
        // What holds without the row: once DECIMALS is supplied at all, the effective
        // tick_decimals is either the row's or the wire's and both are capped at
        // MAX_DECIMALS, so a fraction longer than MAX_DECIMALS is invalid at ANY decimals.
        // With DECIMALS absent, consensus resolves NaN decimals and imposes no cap, so
        // nothing is asserted rather than a 0 being invented.
        let declaredDecimals = allFields ? allFields['DECIMALS'] : undefined;
        let fraction = String(value).split('.')[1];
        if (!validator.isEmpty(declaredDecimals) && fraction && fraction.length > MAX_DECIMALS)
            errors.push(validator._error('INVALID_FIELD_VALUE', 'MAX_SUPPLY cannot carry more than ' + MAX_DECIMALS + ' fractional digits', { field, value, constraint: { maxFractionalDigits: MAX_DECIMALS } }));
    }
}

// Applies one contiguous field-rule group while preserving finding order.
function validateLockFields(validator, action, field, value, allFields, errors) {
    if (validator.config['LOCK_FIELDS'].includes(field)) {
        if (!validator.util.isValidLockValue(value))
            errors.push(validator._error('INVALID_FIELD_VALUE', field + ' must be 0 or 1', { field, value, constraint: { valid: [0, 1] } }));
    }
}

// Applies one contiguous field-rule group while preserving finding order.
function validateFiatCodeField(validator, action, field, value, allFields, errors) {
    // NOTE: ISSUE v6 / ADDRESS v1 controller field checks (CONTROLLER / ACTION_CLASS /
    // UNBIND / COOLDOWN_BLOCKS) live in the consolidated block further down (~line 419).

    if (field === 'FIAT_CODE') {
        if (!VALID_FIAT_CODES.includes(String(value).toUpperCase()))
            errors.push(validator._error('INVALID_FIELD_VALUE', 'FIAT_CODE must be one of: ' + VALID_FIAT_CODES.join(', '), { field, value, constraint: { valid: VALID_FIAT_CODES } }));
    }
}

// Applies one contiguous field-rule group while preserving finding order.
function validatePriceFiatField(validator, action, field, value, allFields, errors) {
    // FIAT validation (PRICE v1's fiat field is named FIAT, not FIAT_CODE).
    // Same allow-list, same arbiter: the indexer rejects an unlisted code with
    // 'invalid: FIAT (unsupported)' (actions/price/index.js), so catching it here
    // saves a miner fee on a doomed publish.
    if (field === 'FIAT' && action === 'PRICE') {
        if (!VALID_FIAT_CODES.includes(String(value).toUpperCase()))
            errors.push(validator._error('INVALID_FIELD_VALUE', 'FIAT must be one of: ' + VALID_FIAT_CODES.join(', '), { field, value, constraint: { valid: VALID_FIAT_CODES } }));
    }
}

// Applies one contiguous field-rule group while preserving finding order.
function validateFiatAmountField(validator, action, field, value, allFields, errors) {
    // FIAT_AMOUNT format validation: a non-negative amount with at most 2
    // decimal places, mirroring the indexer's consensus rule
    // (xchain-indexer utility.isValidFiatFormat(2, ...); identical helper
    // here, plus the explicit negative reject the indexer performs inside
    // its isValidAmountFormat). The SDK must never be stricter than
    // consensus: the old /^\d+\.\d{2}$/ regex demanded exactly two
    // decimals, so every round price ("10", "1.5") was rejected and fiat-
    // priced dispensers could not be created at whole/half price points.
    if (field === 'FIAT_AMOUNT') {
        if (!validator.util.isNumeric(value) || String(value).startsWith('-') || !validator.util.isValidFiatFormat(2, value))
            errors.push(validator._error('INVALID_FIELD_VALUE', 'FIAT_AMOUNT must be a non-negative amount with at most 2 decimal places', { field, value }));
    }
}

// Applies one contiguous field-rule group while preserving finding order.
function validateCoinFields(validator, action, field, value, allFields, errors) {
    if (field === 'COIN' || field === 'GIVE_COIN' || field === 'GET_COIN' || field === 'COIN1' || field === 'COIN2') {
        if (!VALID_COINS.includes(String(value).toUpperCase()))
            errors.push(validator._error('INVALID_FIELD_VALUE', field + ' must be one of: ' + VALID_COINS.join(', '), { field, value, constraint: { valid: VALID_COINS } }));
    }
}

// Applies one contiguous field-rule group while preserving finding order.
function validateAddressReferenceFields(validator, action, field, value, allFields, errors) {
    // ADDRESS_ID reference (^57): valid for any address-bearing field, only
    // outside the full-address form. Mirrors the TICK ^id branch above; the
    // indexer resolves ^<id> via getAddressId, and address_resolver.js emits it.
    if (ADDRESS_REF_FIELD_SET.has(field) && String(value).charAt(0) === '^') {
        let id = String(value).substring(1);
        if (!validator.util.isNumeric(id))
            errors.push(validator._error('INVALID_ADDRESS_ID', field + ' ID reference must be numeric: ' + value, { field, value }));
    }
}

// Applies one contiguous field-rule group while preserving finding order.
function validateAddressFields(validator, action, field, value, allFields, errors) {
    // DESTINATION / GET_ADDRESS / TRANSFER / TRANSFER_SUPPLY full-address
    // validation. A ^<id> reference is handled by the branch above, so skip the
    // crypto-address check for it (an empty value never reaches here; the caller
    // skips empties).
    //
    // TRANSFER_SUPPLY is the address ISSUE credits its MINT_SUPPLY to
    // (xchain-indexer/src/actions/issue.js rejects it as 'bad address' when it
    // is not one), and addressRefFields.js already declares it an ISSUE
    // address-ref field. It was additionally listed as an AMOUNT field below,
    // which rejected every address client-side and made owner issue-and-transfer
    // uncomposable through the SDK.
    if (field === 'DESTINATION' || field === 'GET_ADDRESS' || field === 'TRANSFER' ||
        field === 'TRANSFER_SUPPLY') {
        if (String(value).charAt(0) !== '^' && !validator.util.isCryptoAddress(value))
            errors.push(validator._error('INVALID_FIELD_VALUE', field + ' must be a valid crypto address', { field, value }));
    }
}

// Applies one contiguous field-rule group while preserving finding order.
function validateEncryptionMethodField(validator, action, field, value, allFields, errors) {
    // ENCRYPTION_METHOD validation (numeric in all contexts)
    // - MESSAGE: 1=ECIES, 2=ECDH, 3=AES (symmetric-with-pre-shared-key)
    // - FILE v1 (gated): 1=AES-256-GCM. Other values reserved for future v1 algorithms.
    if (field === 'ENCRYPTION_METHOD') {
        if (action === 'FILE') {
            if (!validator.util.isValidValue(value, [1]))
                errors.push(validator._error('INVALID_FIELD_VALUE',
                    'FILE ENCRYPTION_METHOD must be 1 (AES-256-GCM)',
                    { field, value, constraint: { valid: [1] } }));
        } else if (!validator.util.isValidValue(value, [1, 2, 3])) {
            errors.push(validator._error('INVALID_FIELD_VALUE', 'ENCRYPTION_METHOD must be 1 (ECIES), 2 (ECDH), or 3 (AES)', { field, value, constraint: { valid: [1, 2, 3] } }));
        }
    }
}

module.exports = { FIELD_VALIDATORS: [validateTickFields, validateDescriptionField, validateDecimalsField, validateMaxSupplyField, validateLockFields, validateFiatCodeField, validatePriceFiatField, validateFiatAmountField, validateCoinFields, validateAddressReferenceFields, validateAddressFields, validateEncryptionMethodField] };
