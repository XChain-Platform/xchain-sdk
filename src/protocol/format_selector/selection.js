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
 * XChain Platform SDK - Format Selector serialization
 *
 * Length estimation, version canonicalization and serialization that
 * FormatSelector installs as static methods
 *
 ********************************************************************/

const { SDKFormatError } = require('../../utils/errors.js');
const { LEGS_FIELD } = require('./field_names.js');

// Methods are called as FormatSelector.<name>(), so `this` is the class exactly
// as it was when they were declared static in its body.
module.exports = {

    // Estimate the serialized length of an action string for a given format version
    estimateLength(action, version, fields) {
        if (!fields || typeof fields !== 'object') fields = {};
        let group = this.getRepeatedGroup(action, version);
        let legs  = this.getLegs(fields);
        if (group && legs)
            return this._buildRepeatedParts(action, version, fields, group, legs).join('|').length;
        if (legs && legs.length === 1)
            fields = this._flattenSingleLeg(fields, legs[0]);
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
    },

    // A caller-supplied VERSION as a non-negative integer, or null when the input
    // is not that shape. VERSION is a non-negative integer on the wire, so the
    // shape is checked BEFORE any coercion: a bare Number() reads true, [1],
    // '0x1', '1e0', '1.0' and ' 1 ' all as version 1, and '' and [] as version 0.
    // The format lookup in select() happens to bound the RESULT to a defined
    // version, so nothing misbehaves today, but this SDK is published and the
    // accepted shape of a public input should not be "whatever Number() salvages".
    // A leading-zero string ('01') IS accepted: it cannot mean a different
    // version, so rejecting it would only break callers for no gain.
    _canonicalVersion(value) {
        if (typeof value === 'number')
            return (Number.isInteger(value) && value >= 0) ? value : null;
        if (typeof value === 'string')
            return /^\d+$/.test(value) ? Number(value) : null;
        return null;
    },

    // Serialize an action + version + fields into a pipe-delimited action string
    serialize(action, version, fields) {
        if (!fields || typeof fields !== 'object') fields = {};
        let group = this.getRepeatedGroup(action, version);
        let legs  = this.getLegs(fields);

        if (group) {
            /*
             * Repeated-field format (multi-leg SEND/DESTROY/AIRDROP). A FLAT
             * field map cannot express leg 2: walking the format list would
             * read the same fields[NAME] for every repetition and emit a
             * well-formed action that pays leg 1 twice. Refuse loudly.
             */
            if (!legs)
                throw new SDKFormatError(
                    'REPEATED_FORMAT_REQUIRES_LEGS',
                    action + ' v' + version + ' is a multi-leg format (' + group.group.join('|')
                        + ' repeats) and cannot be built from a flat field map. Pass '
                        + LEGS_FIELD + ': [{ ' + group.group.map(f => f.toLowerCase()).join(', ') + ' }, ...] instead.',
                    { action, version, group: group.group, prefix: group.prefix, suffix: group.suffix }
                );
            let parts = this._buildRepeatedParts(action, version, fields, group, legs);
            while (parts.length > 2 && parts[parts.length - 1] === '')
                parts.pop();
            return parts.join('|');
        }

        // Single-leg format fed a one-leg array: fold the leg into the flat
        // map so `legs:[{...}]` works across every version of an action.
        if (legs) {
            if (legs.length > 1)
                throw new SDKFormatError(
                    'SINGLE_LEG_FORMAT',
                    action + ' v' + version + ' carries a single leg but ' + legs.length + ' were provided',
                    { action, version, legCount: legs.length }
                );
            fields = this._flattenSingleLeg(fields, legs[0]);
        }

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

};
