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

const { FIELD_VALIDATORS: BASIC_FIELD_VALIDATORS } = require('./field_rules_basic.js');
const { FIELD_VALIDATORS: EXTENDED_FIELD_VALIDATORS } = require('./field_rules_extended.js');
const { FIELD_VALIDATORS: PROTOCOL_FIELD_VALIDATORS } = require('./field_rules_protocol.js');
const { FIELD_VALIDATORS: FINAL_FIELD_VALIDATORS } = require('./field_rules_final.js');
const FIELD_VALIDATORS = BASIC_FIELD_VALIDATORS.concat(EXTENDED_FIELD_VALIDATORS, PROTOCOL_FIELD_VALIDATORS, FINAL_FIELD_VALIDATORS);

// Runs each synchronous field group in its original precedence order.
function validateField(validator, action, field, value, allFields) {
    let errors = [];
    for (const validate of FIELD_VALIDATORS)
        validate(validator, action, field, value, allFields, errors);
    return errors;
}

module.exports = { validateField };
