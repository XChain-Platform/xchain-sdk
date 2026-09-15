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
 * XChain Platform SDK - Format Selector
 *
 * Selects the optimal (smallest) format version for a given ACTION
 * and set of populated fields
 *
 ********************************************************************/

const formats = require('./formats.js');
const { SDKFormatError } = require('../utils/errors.js');
const { AUTO_FIELDS, LEGS_FIELD } = require('./format_selector/field_names.js');
const repeatedLegs = require('./format_selector/repeated_legs.js');
const selection = require('./format_selector/selection.js');


class FormatSelector {

    // Get the ordered field list for a given action + version
    // Rest-fields (prefixed with '...') are returned as-is; callers handle expansion
    static getFormatFields(action, version) {
        let formatStr = formats[action][version];
        return formatStr.split('|');
    }

    // Name of the caller-facing per-leg field
    static get LEGS_FIELD() {
        return LEGS_FIELD;
    }

    // Select the optimal format version for a given action and populated fields.
    // If `explicitVersion` is provided, that version is used unconditionally
    // (used by actions like STAKE where V1=new vs V2=top-up have identical
    // field shapes but different semantics (the caller picks).
    // Returns { version, formatFields, estimatedLength }
    static select(action, fields, explicitVersion) {
        // Validate action exists
        if (!formats[action])
            throw new SDKFormatError('UNKNOWN_ACTION', 'Unknown ACTION type: ' + action, { action });

        // Caller forced a specific version: validate and use it without auto-selection
        if (explicitVersion !== undefined && explicitVersion !== null) {
            let v = FormatSelector._canonicalVersion(explicitVersion);
            if (v === null)
                throw new SDKFormatError(
                    'INVALID_VERSION',
                    'VERSION must be a non-negative integer or a decimal-integer string; got ' +
                        typeof explicitVersion + ' ' + JSON.stringify(explicitVersion),
                    { action, version: explicitVersion, availableVersions: Object.keys(formats[action]) }
                );
            if (!formats[action][v])
                throw new SDKFormatError(
                    'INVALID_VERSION',
                    'Version ' + v + ' is not defined for ' + action,
                    { action, version: v, availableVersions: Object.keys(formats[action]) }
                );
            // No data loss on a PINNED version either (#3918). The auto-selection loop
            // below refuses a version with no slot for a populated field; skipping that
            // check here let STAKE v1 serialize away TARGET_CONTRACT_INDEX|TICK and
            // misroute the stake. The caller pinned this version, so fail loudly rather
            // than fall through to another one.
            let pinnedFields = this.getFormatFields(action, v);
            let pinnedSlots  = [...new Set(pinnedFields
                .filter(f => !AUTO_FIELDS.includes(f))
                .map(f => this.baseFieldName(f)))];
            let dropped      = this.getPopulatedFields(fields)
                .filter(f => f !== LEGS_FIELD)
                .filter(f => !pinnedSlots.includes(f));
            if (dropped.length)
                throw new SDKFormatError(
                    'NO_MATCHING_FORMAT',
                    action + ' v' + v + ' has no slot for ' + dropped.join(', ') +
                        '; serializing it would silently discard ' +
                        (dropped.length === 1 ? 'that field' : 'those fields'),
                    { action, version: v, fields: pinnedSlots, userFieldsNotInFormat: dropped }
                );
            // Legs are NOT re-checked here: a pinned version whose per-leg slots cannot
            // carry them already throws downstream with the sharper "legs disagree"
            // diagnostic, and preempting it would only blur the message.
            return {
                version:         v,
                formatFields:    pinnedFields,
                estimatedLength: this.estimateLength(action, v, fields)
            };
        }

        let legs = this.getLegs(fields);
        // LEGS is a caller-side shape, not a wire field: it has no slot in any
        // format, so it never participates in the fits-the-format check.
        let populatedFields = this.getPopulatedFields(fields).filter(f => f !== LEGS_FIELD);
        let actionFormats = formats[action];
        let candidates = [];

        for (let version in actionFormats) {
            version = parseInt(version);
            let formatFields = this.getFormatFields(action, version);
            let group = this.getRepeatedGroup(action, version);

            // Auto-selection never lands on a multi-leg format the caller did
            // not ask for with LEGS: serialize() refuses those, and a
            // single-leg payload always fits a single-leg format anyway.
            if (group && !legs) continue;

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

            if (legs && !this._legsFit(group, uniqueSlots, legs)) continue;

            // This version is eligible: estimate output length
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
            let detail = legs
                ? ' with ' + legs.length + ' leg' + (legs.length === 1 ? '' : 's')
                    + ' (a per-leg field that only exists as a shared slot must be identical across legs)'
                : '';
            throw new SDKFormatError(
                'NO_MATCHING_FORMAT',
                'No format version for ' + action + ' can represent the provided fields' + detail + ': '
                    + populatedFields.concat(legs ? [LEGS_FIELD] : []).join(', '),
                { action, populatedFields, legCount: legs ? legs.length : 0, availableFormats: available }
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

}

// Every static in its original declaration order. The class body keeps the ones
// that need class syntax or name the class; the rest come from the part files.
const STATIC_ORDER = [
    'getFormatFields', 'LEGS_FIELD', 'getRepeatedGroup', 'isRepeatedFormat', 'isRestField',
    'baseFieldName', 'getPopulatedFields', 'getLegs', '_legValue', '_sharedValue', '_legsFit',
    '_flattenSingleLeg', '_repeatedFieldNames', '_buildRepeatedParts', 'estimateLength',
    '_canonicalVersion', 'select', 'serialize'
];

// Install part methods as statics with the descriptor a class `static` method has
// (writable, configurable, NOT enumerable), then re-seat every static in
// STATIC_ORDER so the property order also matches the original class body.
function installStatics(cls, order, parts) {
    let moved = new Map();
    for (let part of parts) {
        for (let name of Object.keys(part)) {
            // A part method must be declared in the order and defined exactly once
            if (!order.includes(name) || moved.has(name) || Object.getOwnPropertyDescriptor(cls, name))
                throw new Error('FormatSelector static ' + name + ' is undeclared or defined twice');
            moved.set(name, part[name]);
        }
    }
    for (let name of order) {
        let descriptor = Object.getOwnPropertyDescriptor(cls, name);
        if (!descriptor && typeof moved.get(name) !== 'function')
            throw new Error('FormatSelector static ' + name + ' has no definition');
        if (!descriptor)
            descriptor = { value: moved.get(name), writable: true, enumerable: false, configurable: true };
        delete cls[name];
        Object.defineProperty(cls, name, descriptor);
    }
}

installStatics(FormatSelector, STATIC_ORDER, [repeatedLegs, selection]);

module.exports = FormatSelector;
