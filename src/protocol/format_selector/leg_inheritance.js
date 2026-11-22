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
 * XChain Platform SDK - leg field inheritance
 *
 * The one rule the serializer and the validator share for filling a leg
 * field from its top-level counterpart, so a payload that validates is the
 * payload that serializes. A leg value of null or undefined takes the
 * top-level value. An empty-string leg value takes it too when the top level
 * holds a single non-empty value, which is how the validator's required-field
 * check reads it; next to an array (the per-leg echo decoder.parse returns)
 * the empty string is the leg's own value and stays.
 *
 ********************************************************************/

'use strict';

const { LEGS_FIELD } = require('./field_names.js');

// A top-level value an empty leg value can inherit: present, non-empty, one value.
function isHoistedValue(value) {
    return value !== null && value !== undefined && value !== '' && !Array.isArray(value);
}

/**
 * The value a leg carries for one field once inheritance is applied.
 *
 * @param {object} leg
 * @param {object} fields  top-level field map
 * @param {string} fieldName
 * @returns {*}
 */
function effectiveLegValue(leg, fields, fieldName) {
    let value = leg[fieldName];
    if (value === null || value === undefined) return fields[fieldName];
    if (value === '' && isHoistedValue(fields[fieldName])) return fields[fieldName];
    return value;
}

/**
 * The flat field map one leg serializes as: the top-level fields with each
 * leg value laid over them under effectiveLegValue, and LEGS dropped.
 *
 * @param {object} fields
 * @param {object} leg
 * @returns {object}
 */
function mergeLegOverFields(fields, leg) {
    let merged = Object.assign({}, fields);
    for (let fieldName of Object.keys(leg)) merged[fieldName] = effectiveLegValue(leg, fields, fieldName);
    delete merged[LEGS_FIELD];
    return merged;
}

module.exports = { effectiveLegValue, mergeLegOverFields };
