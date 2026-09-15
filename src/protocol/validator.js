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

const formats = require('./formats.js');
const config  = require('../config.js');
const { SDKValidationError, SDKContractError } = require('../utils/errors.js');
const { MAX_DEPLOYCHUNK_PART_BYTES } = require('../contract/chunk_helper.js');
const { installMethods } = require('../utils/install_methods.js');
const {
    LEGS_FIELD,
    ADDRESS_REF_FIELD_SET,
    MAX_SUPPLY_CEILING,
    MAX_DECIMALS,
    MAX_DESC_LENGTH,
    MAX_MESSAGE_LENGTH,
    MAX_GATE_MIN_AMOUNT_LENGTH,
    MAX_CODE_SIZE,
    FORBIDDEN_TEXT_CHARS,
    DELIMITER_EXEMPT_FIELDS,
    VALID_FIAT_CODES,
    VALID_COINS,
    ACTION_REQUIRED_FIELDS,
    ACTION_INDEX_FIELDS,
} = require('./validator/field_limits.js');

function validateRequiredFields(validator, action, fields, legs) {
    let errors = [];
    let actionIndexField = ACTION_INDEX_FIELDS[action];
    let isIndexOperation = actionIndexField && !validator._isEmpty(fields[actionIndexField]);

    if (!isIndexOperation) {
        let required = ACTION_REQUIRED_FIELDS[action] || [];
        for (let field of required) {
            // With legs, a required field is satisfied per leg: SEND legs
            // each need AMOUNT/DESTINATION, while a shared TICK may sit at
            // the top level (SEND v1) or inside every leg (v2/v3).
            if (legs) {
                let missingIn = legs
                    .map((leg, i) => (validator._isEmpty(leg[field]) && validator._isEmpty(fields[field])) ? i : -1)
                    .filter(i => i !== -1);
                if (missingIn.length > 0)
                    errors.push(validator._error('MISSING_REQUIRED_FIELD',
                        action + ' requires field: ' + field + ' (missing on leg ' + missingIn.join(', ') + ')',
                        { action, field, legs: missingIn }));
                continue;
            }
            if (validator._isEmpty(fields[field])) {
                errors.push(validator._error('MISSING_REQUIRED_FIELD',
                    action + ' requires field: ' + field,
                    { action, field }));
            }
        }
    }
    return errors;
}

function validateFlatFields(validator, action, fields) {
    let errors = [];
    for (let field in fields) {
        let value = fields[field];
        if (field === LEGS_FIELD) continue;   // shape-checked separately, values checked per leg
        if (validator._isEmpty(value)) continue;

        // Default-deny delimiter guard, applied to every field before its
        // type-specific validation (see DELIMITER_EXEMPT_FIELDS).
        errors.push(...validator._checkDelimiters(field, value));
        errors.push(...validator._validateField(action, field, value, fields));
    }
    return errors;
}

function validateLegFields(validator, action, fields, legs) {
    let errors = [];
    if (!legs) return errors;
    for (let i = 0; i < legs.length; i++) {
        let leg = legs[i];
        let merged = Object.assign({}, fields, leg);
        delete merged[LEGS_FIELD];
        for (let field in leg) {
            let value = leg[field];
            if (validator._isEmpty(value)) continue;
            for (let err of validator._checkDelimiters(field, value))
                errors.push(validator._withLeg(err, i));
            for (let err of validator._validateField(action, field, value, merged))
                errors.push(validator._withLeg(err, i));
        }
    }
    return errors;
}

class Validator {

    constructor(util, network) {
        this.util   = util;
        this.config = config.getConfig();
        // Network LIST TYPE=2 (ADDRESS list) items are checked against: mainnet,
        // testnet and regtest addresses are disjoint byte-prefix/HRP spaces (see
        // isCryptoAddress in utility.js), so a list built for one network must
        // never accept an address shaped for another. Falls back to process.env.NETWORK,
        // matching the SDK-wide network-resolution convention (XChainSDK.js,
        // actions.js), for a caller that only sets NETWORK in the environment and
        // never passes it here explicitly.
        this.network = network || config.env.network() || null;
    }

    // Returns array of error objects. Empty array = valid.
    validate(action, fields) {
        let errors = [];

        // Guard against null/undefined fields
        if (!fields || typeof fields !== 'object') fields = {};

        // Check action exists. Use hasOwnProperty so a crafted action name that
        // matches an Object.prototype property (__proto__, constructor, toString,
        // hasOwnProperty, valueOf, ...) resolves to UNKNOWN_ACTION instead of the
        // truthy inherited value, which otherwise slipped past this guard and
        // then threw "required is not iterable" on the ACTION_REQUIRED_FIELDS
        // lookup below (prototype-pollution-shaped crash in the validation path).
        if (!Object.prototype.hasOwnProperty.call(formats, action)) {
            errors.push(this._error('UNKNOWN_ACTION', 'Unknown ACTION type: ' + action, { action }));
            return errors;
        }

        // Multi-leg shape (LEGS): validated before the flat rules so a leg can
        // satisfy a required field the top-level map does not carry.
        let legs = this._legsOf(fields);
        errors.push(...this._validateLegsShape(action, fields));
        errors.push(...validateRequiredFields(this, action, fields, legs));
        errors.push(...validateFlatFields(this, action, fields));
        errors.push(...validateLegFields(this, action, fields, legs));
        errors.push(...this._validateAction(action, fields));

        return errors;
    }

    _validateField(action, field, value, allFields) {
        let errors = [];

        if (field === 'TICK' || field === 'GIVE_TICK' || field === 'GET_TICK' ||
            field === 'DIVIDEND_TICK' || field === 'CALLBACK_TICK') {
            if (action === 'ISSUE' && field === 'TICK') {
                // Full TICK validation on ISSUE. A caret-led value is an id
                // reference rather than a name and is judged as one (see
                // _validateTickName's first branch).
                errors.push(...this._validateTickName(value, allFields));
            } else if (String(value).startsWith('^')) {
                // TICK_ID reference (^123), only valid outside of ISSUE. A delimiter
                // inside the id is already fatal here: isNumeric tests the WHOLE
                // remainder, so '^1|memo' fails as a non-numeric id.
                let id = String(value).substring(1);
                if (!this.util.isNumeric(id))
                    errors.push(this._error('INVALID_TICK_ID', field + ' ID reference must be numeric: ' + value, { field, value }));
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
                // Delimiters only, deliberately: full _validateTickName on a non-ISSUE
                // reference would make the SDK stricter than consensus and refuse tick
                // names that already exist on chain (the regression the FIAT_AMOUNT note
                // below records shipping once). '|' and ';' are outside TICK_REGEX
                // anyway, so nothing legitimate loses.
                errors.push(...this._scanDelimiters(field, value));
            }
        }

        // MEMO delimiter safety is handled by the default-deny _checkDelimiters guard.

        // DESCRIPTION validation (delimiter safety via _checkDelimiters)
        if (field === 'DESCRIPTION') {
            if (String(value).length > MAX_DESC_LENGTH)
                errors.push(this._error('INVALID_FIELD_VALUE', 'DESCRIPTION must be ' + MAX_DESC_LENGTH + ' characters or less', { field, value: String(value).length, constraint: { max: MAX_DESC_LENGTH } }));
        }

        if (field === 'DECIMALS') {
            if (!Number.isInteger(Number(value)) || Number(value) < 0 || Number(value) > MAX_DECIMALS)
                errors.push(this._error('INVALID_FIELD_VALUE', 'DECIMALS must be an integer between 0 and ' + MAX_DECIMALS, { field, value, constraint: { min: 0, max: MAX_DECIMALS, type: 'integer' } }));
        }

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
                    errors.push(this._error('INVALID_FIELD_VALUE', 'MAX_SUPPLY must be between 0 and ' + MAX_SUPPLY_CEILING, { field, value, constraint: { min: 0, max: MAX_SUPPLY_CEILING } }));
            } catch (e) {
                errors.push(this._error('INVALID_FIELD_VALUE', 'MAX_SUPPLY must be numeric', { field, value }));
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
            if (!this._isEmpty(declaredDecimals) && fraction && fraction.length > MAX_DECIMALS)
                errors.push(this._error('INVALID_FIELD_VALUE', 'MAX_SUPPLY cannot carry more than ' + MAX_DECIMALS + ' fractional digits', { field, value, constraint: { maxFractionalDigits: MAX_DECIMALS } }));
        }

        if (this.config['LOCK_FIELDS'].includes(field)) {
            if (!this.util.isValidLockValue(value))
                errors.push(this._error('INVALID_FIELD_VALUE', field + ' must be 0 or 1', { field, value, constraint: { valid: [0, 1] } }));
        }
        // NOTE: ISSUE v6 / ADDRESS v1 controller field checks (CONTROLLER / ACTION_CLASS /
        // UNBIND / COOLDOWN_BLOCKS) live in the consolidated block further down (~line 419).

        if (field === 'FIAT_CODE') {
            if (!VALID_FIAT_CODES.includes(String(value).toUpperCase()))
                errors.push(this._error('INVALID_FIELD_VALUE', 'FIAT_CODE must be one of: ' + VALID_FIAT_CODES.join(', '), { field, value, constraint: { valid: VALID_FIAT_CODES } }));
        }

        // FIAT validation (PRICE v1's fiat field is named FIAT, not FIAT_CODE).
        // Same allow-list, same arbiter: the indexer rejects an unlisted code with
        // 'invalid: FIAT (unsupported)' (actions/price/index.js), so catching it here
        // saves a miner fee on a doomed publish.
        if (field === 'FIAT' && action === 'PRICE') {
            if (!VALID_FIAT_CODES.includes(String(value).toUpperCase()))
                errors.push(this._error('INVALID_FIELD_VALUE', 'FIAT must be one of: ' + VALID_FIAT_CODES.join(', '), { field, value, constraint: { valid: VALID_FIAT_CODES } }));
        }

        // FIAT_AMOUNT format validation: a non-negative amount with at most 2
        // decimal places, mirroring the indexer's consensus rule
        // (xchain-indexer utility.isValidFiatFormat(2, ...); identical helper
        // here, plus the explicit negative reject the indexer performs inside
        // its isValidAmountFormat). The SDK must never be stricter than
        // consensus: the old /^\d+\.\d{2}$/ regex demanded exactly two
        // decimals, so every round price ("10", "1.5") was rejected and fiat-
        // priced dispensers could not be created at whole/half price points.
        if (field === 'FIAT_AMOUNT') {
            if (!this.util.isNumeric(value) || String(value).startsWith('-') || !this.util.isValidFiatFormat(2, value))
                errors.push(this._error('INVALID_FIELD_VALUE', 'FIAT_AMOUNT must be a non-negative amount with at most 2 decimal places', { field, value }));
        }

        if (field === 'COIN' || field === 'GIVE_COIN' || field === 'GET_COIN' || field === 'COIN1' || field === 'COIN2') {
            if (!VALID_COINS.includes(String(value).toUpperCase()))
                errors.push(this._error('INVALID_FIELD_VALUE', field + ' must be one of: ' + VALID_COINS.join(', '), { field, value, constraint: { valid: VALID_COINS } }));
        }

        // ADDRESS_ID reference (^57): valid for any address-bearing field, only
        // outside the full-address form. Mirrors the TICK ^id branch above; the
        // indexer resolves ^<id> via getAddressId, and address_resolver.js emits it.
        if (ADDRESS_REF_FIELD_SET.has(field) && String(value).charAt(0) === '^') {
            let id = String(value).substring(1);
            if (!this.util.isNumeric(id))
                errors.push(this._error('INVALID_ADDRESS_ID', field + ' ID reference must be numeric: ' + value, { field, value }));
        }

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
            if (String(value).charAt(0) !== '^' && !this.util.isCryptoAddress(value))
                errors.push(this._error('INVALID_FIELD_VALUE', field + ' must be a valid crypto address', { field, value }));
        }

        // ENCRYPTION_METHOD validation (numeric in all contexts)
        // - MESSAGE: 1=ECIES, 2=ECDH, 3=AES (symmetric-with-pre-shared-key)
        // - FILE v1 (gated): 1=AES-256-GCM. Other values reserved for future v1 algorithms.
        if (field === 'ENCRYPTION_METHOD') {
            if (action === 'FILE') {
                if (!this.util.isValidValue(value, [1]))
                    errors.push(this._error('INVALID_FIELD_VALUE',
                        'FILE ENCRYPTION_METHOD must be 1 (AES-256-GCM)',
                        { field, value, constraint: { valid: [1] } }));
            } else if (!this.util.isValidValue(value, [1, 2, 3])) {
                errors.push(this._error('INVALID_FIELD_VALUE', 'ENCRYPTION_METHOD must be 1 (ECIES), 2 (ECDH), or 3 (AES)', { field, value, constraint: { valid: [1, 2, 3] } }));
            }
        }

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
                errors.push(this._error('INVALID_FIELD_VALUE',
                    'KEY_HASH must be 64 hex characters, sha256(K); emit it lowercase, ' +
                    'the chain accepts either case and records the lowercase form',
                    { field, value }));
        }
        if (action === 'FILE' && field === 'GATE_TICKER') {
            // Empty is allowed (= public file); when set, basic TICK constraints apply.
            if (value !== '' && /[|;./]/.test(String(value)))
                errors.push(this._error('INVALID_FIELD_VALUE',
                    'GATE_TICKER cannot contain |, ;, ., or /',
                    { field, value }));
        }

        // PC-29: GATE_MIN_AMOUNT, the unlock threshold (spec §5.2).
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
                const bad = (msg, extra) => errors.push(this._error('INVALID_FIELD_VALUE',
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

        // FILE NAME/TYPE/TITLE delimiter safety is handled by _checkDelimiters.

        // MESSAGE content length validation (delimiter safety via _checkDelimiters)
        if (field === 'PLAINTEXT_MESSAGE' || field === 'ENCRYPTED_MESSAGE' || field === 'ENCRYPTION_KEY') {
            if (String(value).length > MAX_MESSAGE_LENGTH)
                errors.push(this._error('INVALID_FIELD_VALUE', field + ' must be ' + MAX_MESSAGE_LENGTH + ' characters or less', { field, value: String(value).length, constraint: { max: MAX_MESSAGE_LENGTH } }));
        }

        // FEE_PREFERENCE validation (ADDRESS action)
        if (field === 'FEE_PREFERENCE') {
            if (!this.util.isValidValue(value, [1, 2, 3]))
                errors.push(this._error('INVALID_FIELD_VALUE', 'FEE_PREFERENCE must be 1 (destroy), 2 (protocol), or 3 (community)', { field, value, constraint: { valid: [1, 2, 3] } }));
        }

        // DISPENSER_PREFERENCE validation (ADDRESS action): who may open dispensers on this address
        if (field === 'DISPENSER_PREFERENCE') {
            if (!this.util.isValidValue(value, [1, 2]))
                errors.push(this._error('INVALID_FIELD_VALUE', 'DISPENSER_PREFERENCE must be 1 (owner only) or 2 (anyone)', { field, value, constraint: { valid: [1, 2] } }));
        }

        if (field === 'TYPE' && action === 'LIST') {
            if (!this.util.isValidValue(value, [1, 2]))
                errors.push(this._error('INVALID_FIELD_VALUE', 'LIST TYPE must be 1 (TICK list) or 2 (ADDRESS list)', { field, value, constraint: { valid: [1, 2] } }));
        }

        // LIST ITEM (rest-field), VOTE free-text fields, and ALLOW_LIST/BLOCK_LIST
        // delimiter safety are all handled by the default-deny _checkDelimiters guard
        // (which iterates array/rest values element-by-element).

        if (field === 'EDIT') {
            if (!this.util.isValidValue(value, [1, 2]))
                errors.push(this._error('INVALID_FIELD_VALUE', 'EDIT must be 1 (ADD) or 2 (REMOVE)', { field, value, constraint: { valid: [1, 2] } }));
        }

        // Binary 0/1 flag fields
        // - SWEEP:               BALANCES / OWNERSHIPS / ORDERS / SWAPS / DISPENSERS
        // - ORDER / SWAP / DISPENSER: GIVE_OWNERSHIP / GET_OWNERSHIP
        if (field === 'BALANCES' || field === 'OWNERSHIPS' ||
            field === 'ORDERS'   || field === 'SWAPS'      || field === 'DISPENSERS' ||
            field === 'GIVE_OWNERSHIP' || field === 'GET_OWNERSHIP') {
            if (!this.util.isValidLockValue(value))
                errors.push(this._error('INVALID_FIELD_VALUE', field + ' must be 0 or 1', { field, value, constraint: { valid: [0, 1] } }));
        }

        // AMOUNT validation: all listed fields must be numeric.
        if (field === 'AMOUNT' || field === 'GIVE_AMOUNT' || field === 'GET_AMOUNT' ||
            field === 'GIVE_ESCROW' || field === 'CALLBACK_AMOUNT' ||
            field === 'MINT_SUPPLY' || field === 'MAX_MINT' || field === 'MINT_ADDRESS_MAX') {
            if (!this.util.isNumeric(value))
                errors.push(this._error('INVALID_FIELD_VALUE', field + ' must be numeric', { field, value }));
        }

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
        // panel, which offers it. Found by the fiat dispenser e2e lane
        // which could not get past the form.
        // Exactly ZERO, not merely non-positive: the convention is a zero
        // placeholder standing in for "derived later", and a negative price is
        // nonsense in either lane. Written the loose way first, and the unit
        // case below caught it letting -1 through.
        const fiatPricedDispenser = action === 'DISPENSER' && field === 'GET_AMOUNT'
            && Number(value) === 0
            && (!this._isEmpty(allFields?.FIAT_CODE) || !this._isEmpty(allFields?.ORACLE_ADDRESS));
        if (field === 'AMOUNT' || field === 'GIVE_AMOUNT' || field === 'GET_AMOUNT' ||
            field === 'GIVE_ESCROW' || field === 'CALLBACK_AMOUNT') {
            if (!fiatPricedDispenser && this.util.isNumeric(value) && Number(value) <= 0)
                errors.push(this._error('INVALID_FIELD_VALUE', field + ' must be a positive number', { field, value }));
        }

        // FEE validation (BROADCAST, percentage format)
        if (field === 'FEE' && action === 'BROADCAST') {
            if (!this.util.isNumeric(value))
                errors.push(this._error('INVALID_FIELD_VALUE', 'FEE must be numeric (percentage)', { field, value }));
        }

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
            if (!/^[0-9]+(\.[0-9]{1,18})?$/.test(String(value)) || this.util.bcnum(String(value)).gt('1'))
                errors.push(this._error('INVALID_FIELD_VALUE', 'FEE must be a fraction between 0 and 1 with at most 18 decimals', { field, value, constraint: { min: 0, max: 1 } }));
        }

        if (field === 'RESUME_BLOCK' || field === 'CALLBACK_BLOCK' ||
            field === 'MINT_START_BLOCK' || field === 'MINT_STOP_BLOCK') {
            if (!this.util.isNumeric(value))
                errors.push(this._error('INVALID_FIELD_VALUE', field + ' must be numeric', { field, value }));
        }

        // ACTION_INDEX fields must be numeric
        if (field === 'BROADCAST_ACTION_INDEX' || field === 'DISPENSER_ACTION_INDEX' ||
            field === 'ORDER_ACTION_INDEX' || field === 'SWAP_ACTION_INDEX' ||
            field === 'LIST_ACTION_INDEX' || field === 'COIN1_ACTION_INDEX' ||
            field === 'COIN2_ACTION_INDEX' || field === 'CONTRACT_ACTION_INDEX') {
            if (!this.util.isNumeric(value))
                errors.push(this._error('INVALID_FIELD_VALUE', field + ' must be numeric', { field, value }));
        }

        // GAS_LIMIT validation (must be positive integer)
        if (field === 'GAS_LIMIT') {
            if (!this.util.isNumeric(value) || Number(value) <= 0 || !Number.isInteger(Number(value)))
                errors.push(this._error('INVALID_FIELD_VALUE', 'GAS_LIMIT must be a positive integer', { field, value }));
        }

        // QUANTITY validation (must be numeric and positive)
        if (field === 'QUANTITY') {
            if (!this.util.isNumeric(value) || Number(value) <= 0)
                errors.push(this._error('INVALID_FIELD_VALUE', 'QUANTITY must be a positive number', { field, value }));
        }

        // VOTE v0 binding-poll numeric fields. Consensus (indexer actions/vote.js)
        // requires DEPOSIT and GAS_ESCROW to be non-negative amounts and
        // CALLBACK_CONTRACT to be numeric (a contract ACTION_INDEX, resolved via
        // parseInt); check the same shape client-side so a bad value fails before
        // broadcast instead of producing an on-chain invalid action.
        if (field === 'DEPOSIT' || field === 'GAS_ESCROW') {
            if (!this.util.isNumeric(value) || Number(value) < 0)
                errors.push(this._error('INVALID_FIELD_VALUE', field + ' must be a non-negative number', { field, value, constraint: { min: 0 } }));
        }
        if (field === 'CALLBACK_CONTRACT') {
            if (!/^[0-9]+$/.test(String(value)))
                errors.push(this._error('INVALID_FIELD_VALUE', 'CALLBACK_CONTRACT must be a non-negative integer (a contract ACTION_INDEX)', { field, value }));
        }
        if (field === 'CALLBACK_DELAY_BLOCKS') {
            if (!/^[0-9]+$/.test(String(value)))
                errors.push(this._error('INVALID_FIELD_VALUE', 'CALLBACK_DELAY_BLOCKS must be a non-negative integer (blocks between finalize and the callback firing)', { field, value }));
        }

        // METHOD validation (non-empty; delimiter safety via _checkDelimiters)
        if (field === 'METHOD') {
            if (typeof value !== 'string' || value.length === 0)
                errors.push(this._error('INVALID_FIELD_VALUE', 'METHOD must be a non-empty string', { field, value }));
        }

        // CODE_ENCODING validation (base64 string, decoded-size limit)
        if (field === 'CODE_ENCODING') {
            let b64 = String(value);
            if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
                errors.push(this._error('INVALID_FIELD_VALUE', 'CODE_ENCODING must be a valid base64 string', { field }));
            } else {
                let bytes = Buffer.from(b64, 'base64').length; // decoded source size
                if (bytes > MAX_CODE_SIZE)
                    errors.push(this._error('CODE_TOO_LARGE', 'Contract code exceeds ' + MAX_CODE_SIZE + ' byte limit (' + bytes + ' bytes)', { field, bytes, limit: MAX_CODE_SIZE }));
            }
        }

        // CODE_HASH validation: DEPLOY v2/v3 assemble + v4 carrier group key (sha256 hex)
        if (field === 'CODE_HASH') {
            if (!/^[0-9a-f]{64}$/.test(String(value)))
                errors.push(this._error('INVALID_FIELD_VALUE', 'CODE_HASH must be a 64-char lowercase sha256 hex string', { field }));
        }

        // CODE_PART validation (one base64 slice of a chunked contract's source)
        if (field === 'CODE_PART') {
            let part = String(value);
            if (!/^[A-Za-z0-9+/]*={0,2}$/.test(part))
                errors.push(this._error('INVALID_FIELD_VALUE', 'CODE_PART must be a valid base64 string', { field }));
            else if (Buffer.byteLength(part, 'utf8') > MAX_DEPLOYCHUNK_PART_BYTES)
                errors.push(this._error('CODE_PART_TOO_LARGE', 'CODE_PART exceeds ' + MAX_DEPLOYCHUNK_PART_BYTES + ' byte limit', { field, limit: MAX_DEPLOYCHUNK_PART_BYTES }));
        }

        // CHUNK_INDEX / TOTAL_CHUNKS validation (non-negative integers; bounds checked cross-field)
        if (field === 'CHUNK_INDEX' || field === 'TOTAL_CHUNKS') {
            if (!this.util.isNumeric(value) || !Number.isInteger(Number(value)) || Number(value) < 0)
                errors.push(this._error('INVALID_FIELD_VALUE', field + ' must be a non-negative integer', { field, value }));
        }

        // CONSTRUCTOR_PARAMS / PARAMS validation (array items must not contain separators)
        if (field === 'CONSTRUCTOR_PARAMS' || field === 'PARAMS') {
            if (Array.isArray(value)) {
                for (let i = 0; i < value.length; i++) {
                    let param = String(value[i]);
                    for (let ch of FORBIDDEN_TEXT_CHARS) {
                        if (param.includes(ch))
                            errors.push(this._error('INVALID_PARAM_VALUE', field + '[' + i + '] cannot contain ' + (ch === '|' ? 'pipe (|)' : 'semicolon (;)'), { field, index: i, value: param }));
                    }
                }
            }
        }

        // SIGNING_PUBKEY / NEW_SIGNING_PUBKEY validation (64 hex chars, Ed25519)
        if (field === 'SIGNING_PUBKEY' || field === 'NEW_SIGNING_PUBKEY') {
            if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value))
                errors.push(this._error('INVALID_FIELD_VALUE', field + ' must be a 64-character hex string (Ed25519 public key)', { field, value }));
        }

        // TARGET_CONTRACT_INDEX validation (STAKE v3 / UNSTAKE v1 / DELEGATE v1): must be a positive integer
        if (field === 'TARGET_CONTRACT_INDEX') {
            if (!/^[0-9]+$/.test(String(value)) || Number(value) <= 0)
                errors.push(this._error('INVALID_FIELD_VALUE', 'TARGET_CONTRACT_INDEX must be a positive integer', { field, value }));
        }

        // CONTROLLER validation (ISSUE v6 / ADDRESS v1, controller bind/unbind):
        // ACTION_INDEX of a deployed guard contract, so a non-negative integer.
        if (field === 'CONTROLLER') {
            if (!/^[0-9]+$/.test(String(value)))
                errors.push(this._error('INVALID_FIELD_VALUE', 'CONTROLLER must be a non-negative integer (a contract ACTION_INDEX)', { field, value }));
        }

        // ACTION_CLASS validation (ISSUE v6 / ADDRESS v1, programmable policy
        // layer): which native action class the guard gates. Must be one of the
        // indexer's CONTROLLER_ACTION_CLASSES (case-insensitive on the wire);
        // mirrored here as config['ACTION_CLASSES'].
        if (field === 'ACTION_CLASS') {
            let classes = this.config['ACTION_CLASSES'] || [];
            if (classes.indexOf(String(value).toLowerCase()) === -1)
                errors.push(this._error('INVALID_FIELD_VALUE', 'ACTION_CLASS must be one of: ' + classes.join(', '), { field, value, constraint: { valid: classes } }));
        }

        // UNBIND validation (ISSUE v6 / ADDRESS v1): 0 = bind / 1 = unbind.
        if (field === 'UNBIND') {
            if (!this.util.isValidLockValue(value))
                errors.push(this._error('INVALID_FIELD_VALUE', 'UNBIND must be 0 (bind) or 1 (unbind)', { field, value, constraint: { valid: [0, 1] } }));
        }

        // COOLDOWN_BLOCKS validation. Two callers with different ranges:
        //  - DEPLOY v1 (stakeable contract): integer in [1, 100000].
        //  - ISSUE v6 / ADDRESS v1 (controller bind): non-negative integer (>= 0),
        //    committed at bind as the friction on a later unbind (the indexer
        //    accepts /^\d+$/, so 0 is valid).
        if (field === 'COOLDOWN_BLOCKS') {
            if (value !== '' && value !== null && value !== undefined) {
                if (action === 'ISSUE' || action === 'ADDRESS') {
                    if (!/^[0-9]+$/.test(String(value)))
                        errors.push(this._error('INVALID_FIELD_VALUE', 'COOLDOWN_BLOCKS must be a non-negative integer', { field, value, constraint: { min: 0 } }));
                } else if (!this.util.isNumeric(value)) {
                    errors.push(this._error('INVALID_FIELD_VALUE', 'COOLDOWN_BLOCKS must be numeric', { field, value }));
                } else {
                    let cb = Number(value);
                    if (cb < 1 || cb > 100000)
                        errors.push(this._error('INVALID_FIELD_VALUE', 'COOLDOWN_BLOCKS must be in [1, 100000]', { field, value, constraint: { min: 1, max: 100000 } }));
                }
            }
        }

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
                    errors.push(this._error('INVALID_FIELD_VALUE',
                        'BRIDGE_CHAINS must be "-" or a comma list of chain coins ('
                        + VALID_COINS.join(', ') + '), excluding this chain; "' + chain + '" is not one',
                        { field, value: chain, constraint: { valid: VALID_COINS } }));
                    break;
                }
            }
        }

        // MIN_DEPTH is a raise-only confirmation depth: the federation honours
        // max(platform default, MIN_DEPTH), so 0 is "no raise" and a negative or
        // fractional value is meaningless. Digits only, mirroring
        // xchain-indexer/src/actions/issue.js:873 ('invalid: MIN_DEPTH (format)').
        if (field === 'MIN_DEPTH') {
            if (!/^[0-9]+$/.test(String(value)))
                errors.push(this._error('INVALID_FIELD_VALUE',
                    'MIN_DEPTH must be a whole number of confirmations (digits only)',
                    { field, value }));
        }

        if (field === 'VALUE') {
            if (!this.util.isNumeric(value))
                errors.push(this._error('INVALID_FIELD_VALUE', 'VALUE must be numeric', { field, value }));
        }

        // VALUE validation (PRICE v1: the published token price in FIAT). Stricter
        // than the generic numeric check above and matched to the indexer's
        // 'invalid: VALUE (format)' rule: a positive decimal, at most 8 places.
        // A zero or negative price is not a price, and a 9th decimal is silently
        // unpublishable, so both are worth catching before the fee is spent.
        if (field === 'VALUE' && action === 'PRICE') {
            if (!/^[0-9]+(\.[0-9]{1,8})?$/.test(String(value)) || Number(value) <= 0)
                errors.push(this._error('INVALID_FIELD_VALUE', 'VALUE must be a positive price with at most 8 decimal places', { field, value }));
        }

        // BROADCAST MESSAGE delimiter safety is handled by _checkDelimiters.

        return errors;
    }

    validateOrThrow(action, fields) {
        let errors = this.validate(action, fields);
        if (errors.length > 0) {
            throw new SDKValidationError(
                errors[0].code,
                errors.length === 1
                    ? errors[0].message
                    : errors.length + ' validation errors: ' + errors.map(e => e.message).join('; '),
                { action, errors }
            );
        }
    }

}

installMethods(Validator.prototype, require('./validator/legs_and_actions.js'), require('./validator/batch_and_bet.js'), require('./validator/market_and_contract.js'), require('./validator/tick_and_text.js'));

module.exports = Object.assign(Validator, {
    // Exported for the cross-service regression suite, which asserts this equals the
    // canonical protocol MAX_CODE_SIZE shared by the indexer and the VM.
    MAX_CODE_SIZE,

    // Exported for the cross-service FIAT-allow-list parity test (must equal the
    // canonical protocol.VALID_FIAT_CODES, which mirrors the indexer arbiter).
    VALID_FIAT_CODES,
});
