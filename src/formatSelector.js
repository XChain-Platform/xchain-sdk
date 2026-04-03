/*********************************************************************
 *
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 *
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided "AS IS", without warranties or conditions of any kind.
 *
 **********************************************************************
 *
 * XChain Platform SDK - Format Selector
 *
 * Selects the optimal (smallest) format version for a given ACTION
 * and set of populated fields
 *
 ********************************************************************/

const formats = require('./formats.js');
const { SDKFormatError } = require('./errors.js');

// VERSION is always auto-set by the SDK, never user-provided
const AUTO_FIELDS = ['VERSION'];

// Rest-field prefix: fields starting with '...' absorb variable-length array values
const REST_PREFIX = '...';


class FormatSelector {

    // Get the ordered field list for a given action + version
    // Rest-fields (prefixed with '...') are returned as-is; callers handle expansion
    static getFormatFields(action, version) {
        let formatStr = formats[action][version];
        return formatStr.split('|');
    }

    // Check if a field name is a rest-field (variable-length array)
    static isRestField(fieldName) {
        return fieldName.startsWith(REST_PREFIX);
    }

    // Get the base name of a field (strips '...' prefix if present)
    static baseFieldName(fieldName) {
        return fieldName.startsWith(REST_PREFIX) ? fieldName.substring(REST_PREFIX.length) : fieldName;
    }

    // Determine which user-provided fields are "populated" (non-null, non-empty)
    static getPopulatedFields(fields) {
        if (!fields || typeof fields !== 'object') return [];
        let populated = [];
        for (let key in fields) {
            let value = fields[key];
            if (value !== null && value !== undefined && value !== '')
                populated.push(key);
        }
        return populated;
    }

    // Estimate the serialized length of an action string for a given format version
    static estimateLength(action, version, fields) {
        if (!fields || typeof fields !== 'object') fields = {};
        let formatFields = this.getFormatFields(action, version);
        // Start with "ACTION|"
        let length = action.length + 1;
        for (let i = 0; i < formatFields.length; i++) {
            let fieldName = formatFields[i];

            // Handle rest-fields (variable-length arrays)
            if (this.isRestField(fieldName)) {
                let baseName = this.baseFieldName(fieldName);
                let arr = fields[baseName];
                if (Array.isArray(arr) && arr.length > 0) {
                    for (let j = 0; j < arr.length; j++) {
                        length += String(arr[j]).length;
                        if (j < arr.length - 1) length += 1; // pipe between params
                    }
                }
                continue;
            }

            let value = '';
            if (fieldName === 'VERSION') {
                value = String(version);
            } else if (fields[fieldName] !== null && fields[fieldName] !== undefined) {
                value = String(fields[fieldName]);
            }
            // Add pipe separator + value (first field has no leading pipe since ACTION| already added)
            length += value.length;
            if (i < formatFields.length - 1)
                length += 1; // pipe separator between fields
        }
        return length;
    }

    // Select the optimal format version for a given action and populated fields
    // Returns { version, formatFields, estimatedLength }
    static select(action, fields) {
        // Validate action exists
        if (!formats[action])
            throw new SDKFormatError('UNKNOWN_ACTION', 'Unknown ACTION type: ' + action, { action });

        let populatedFields = this.getPopulatedFields(fields);
        let actionFormats = formats[action];
        let candidates = [];

        for (let version in actionFormats) {
            version = parseInt(version);
            let formatFields = this.getFormatFields(action, version);

            // Strip auto-fields for comparison; normalize rest-field names
            let userSlots = formatFields
                .filter(f => !AUTO_FIELDS.includes(f))
                .map(f => this.baseFieldName(f));

            // Deduplicate format field names (multi-item formats repeat TICK, AMOUNT, etc.)
            let uniqueSlots = [...new Set(userSlots)];

            // Rule: Every populated field must have a slot in this format (no data loss)
            // Unprovided fields are filled with defaults (empty string / 0) during serialization.
            // Semantic required-field checking is handled by the Validator, not here.
            let allFieldsFit = true;
            for (let field of populatedFields) {
                if (!uniqueSlots.includes(field)) {
                    allFieldsFit = false;
                    break;
                }
            }
            if (!allFieldsFit) continue;

            // This version is eligible — estimate output length
            let estimatedLength = this.estimateLength(action, version, fields);
            candidates.push({ version, formatFields, estimatedLength });
        }

        if (candidates.length === 0) {
            // Build rejection reasons for developer debugging
            let available = {};
            for (let v in actionFormats) {
                let ff = this.getFormatFields(action, parseInt(v));
                let uniqueSlots = [...new Set(ff.filter(f => !AUTO_FIELDS.includes(f)))];
                let missing = populatedFields.filter(f => !uniqueSlots.includes(f));
                available[v] = {
                    fields: uniqueSlots,
                    userFieldsNotInFormat: missing
                };
            }
            throw new SDKFormatError(
                'NO_MATCHING_FORMAT',
                'No format version for ' + action + ' can represent the provided fields: ' + populatedFields.join(', '),
                { action, populatedFields, availableFormats: available }
            );
        }

        // Sort by estimated length ascending, then by version ascending for ties
        candidates.sort((a, b) => {
            if (a.estimatedLength !== b.estimatedLength)
                return a.estimatedLength - b.estimatedLength;
            return a.version - b.version;
        });

        return candidates[0];
    }

    // Serialize an action + version + fields into a pipe-delimited action string
    static serialize(action, version, fields) {
        if (!fields || typeof fields !== 'object') fields = {};
        let formatFields = this.getFormatFields(action, version);
        let parts = [action];
        for (let fieldName of formatFields) {
            if (fieldName === 'VERSION') {
                parts.push(String(version));
            } else if (this.isRestField(fieldName)) {
                // Rest-field: expand array values as individual pipe-delimited segments
                let baseName = this.baseFieldName(fieldName);
                let arr = fields[baseName];
                if (Array.isArray(arr) && arr.length > 0) {
                    for (let item of arr) {
                        parts.push(item !== null && item !== undefined ? String(item) : '');
                    }
                }
            } else {
                let value = fields[fieldName];
                parts.push(value !== null && value !== undefined ? String(value) : '');
            }
        }

        // Trim trailing empty fields (but keep at least ACTION|VERSION)
        while (parts.length > 2 && parts[parts.length - 1] === '')
            parts.pop();

        return parts.join('|');
    }

}

module.exports = FormatSelector;
