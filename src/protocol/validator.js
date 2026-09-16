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
const { SDKValidationError } = require('../utils/errors.js');
const { installMethods } = require('../utils/install_methods.js');
const { validateField } = require('./validator/field_rules.js');
const {
    LEGS_FIELD,
    MAX_CODE_SIZE,
    VALID_FIAT_CODES,
    ACTION_REQUIRED_FIELDS,
    ACTION_INDEX_FIELDS,
} = require('./validator/field_limits.js');

function validateRequiredFields(validator, action, fields, legs) {
    let errors = [];
    let actionIndexField = ACTION_INDEX_FIELDS[action];
    let isIndexOperation = actionIndexField && !validator.isEmpty(fields[actionIndexField]);

    if (!isIndexOperation) {
        let required = ACTION_REQUIRED_FIELDS[action] || [];
        for (let field of required) {
            // With legs, a required field is satisfied per leg: SEND legs
            // each need AMOUNT/DESTINATION, while a shared TICK may sit at
            // the top level (SEND v1) or inside every leg (v2/v3).
            if (legs) {
                let missingIn = legs
                    .map((leg, i) => (validator.isEmpty(leg[field]) && validator.isEmpty(fields[field])) ? i : -1)
                    .filter(i => i !== -1);
                if (missingIn.length > 0)
                    errors.push(validator._error('MISSING_REQUIRED_FIELD',
                        action + ' requires field: ' + field + ' (missing on leg ' + missingIn.join(', ') + ')',
                        { action, field, legs: missingIn }));
                continue;
            }
            if (validator.isEmpty(fields[field])) {
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
        if (validator.isEmpty(value)) continue;

        // Default-deny delimiter guard, applied to every field before its
        // type-specific validation (see DELIMITER_EXEMPT_FIELDS).
        errors.push(...validator.checkDelimiters(field, value));
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
            if (validator.isEmpty(value)) continue;
            for (let err of validator.checkDelimiters(field, value))
                errors.push(validator.withLeg(err, i));
            for (let err of validator._validateField(action, field, value, merged))
                errors.push(validator.withLeg(err, i));
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
        let legs = this.legsOf(fields);
        errors.push(...this.validateLegsShape(action, fields));
        errors.push(...validateRequiredFields(this, action, fields, legs));
        errors.push(...validateFlatFields(this, action, fields));
        errors.push(...validateLegFields(this, action, fields, legs));
        errors.push(...this.validateAction(action, fields));

        return errors;
    }

    _validateField(action, field, value, allFields) {
        return validateField(this, action, field, value, allFields);
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
