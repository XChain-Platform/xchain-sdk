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
 * XChain Platform SDK - Format Selector repeated legs
 *
 * Field-name helpers and the per-leg (repeated group) machinery that
 * FormatSelector installs as static methods
 *
 ********************************************************************/

const { SDKFormatError } = require('../../utils/errors.js');
const { AUTO_FIELDS, REST_PREFIX, LEGS_FIELD } = require('./field_names.js');

// Memoized repeated-group decompositions, keyed 'ACTION|VERSION'. `null` is a
// cached "no repeat" answer, so the derivation runs once per format.
const GROUP_CACHE = new Map();

// Methods are called as FormatSelector.<name>(), so `this` is the class exactly
// as it was when they were declared static in its body.
module.exports = {

    /*
     * Decompose a repeated-field format into prefix | group* | suffix.
     *
     * formats.js writes multi-leg formats with the group spelled TWICE (the
     * canonical two-leg example: SEND v1 is
     * VERSION|TICK|AMOUNT|DESTINATION|AMOUNT|DESTINATION|MEMO), while the
     * indexer accepts N repetitions. The group is therefore recoverable as the
     * longest adjacent duplicated block of field names: prefix = fields before
     * it (shared, one slot on the wire), group = the per-leg fields, suffix =
     * fields after the second copy (also shared).
     *
     * Longest-first so SEND v3's 4-field group (TICK|AMOUNT|DESTINATION|MEMO)
     * is not mis-read as a shorter one. Returns null for a non-repeating format.
     */
    getRepeatedGroup(action, version) {
        let key = action + '|' + version;
        if (GROUP_CACHE.has(key)) return GROUP_CACHE.get(key);

        let fields = this.getFormatFields(action, version);
        let result = null;
        for (let size = Math.floor(fields.length / 2); size >= 1 && !result; size--) {
            for (let start = 0; start + (2 * size) <= fields.length; start++) {
                let block = fields.slice(start, start + size);
                // Groups are user data only: VERSION and rest-fields never repeat
                if (block.some(f => AUTO_FIELDS.includes(f) || this.isRestField(f))) continue;
                let match = true;
                for (let i = 0; i < size; i++) {
                    if (fields[start + i] !== fields[start + size + i]) { match = false; break; }
                }
                if (!match) continue;
                result = {
                    prefix: fields.slice(0, start),
                    group:  block,
                    suffix: fields.slice(start + (2 * size))
                };
                break;
            }
        }

        // Fail closed on a format that repeats a field name in a shape this
        // decomposition cannot express: silently reusing leg 1's value for
        // leg 2 is exactly the bug this machinery exists to prevent.
        if (!result) {
            let seen = new Set();
            for (let f of fields) {
                if (AUTO_FIELDS.includes(f)) continue;
                if (seen.has(f))
                    throw new SDKFormatError(
                        'UNSUPPORTED_REPEATED_FORMAT',
                        'Format ' + action + ' v' + version + ' repeats field ' + f + ' in a shape the serializer cannot express as per-leg groups',
                        { action, version, field: f, format: fields.join('|') }
                    );
                seen.add(f);
            }
        }

        GROUP_CACHE.set(key, result);
        return result;
    },

    // Whether a format carries a repeated per-leg group (multi-leg SEND etc.)
    isRepeatedFormat(action, version) {
        return this.getRepeatedGroup(action, version) !== null;
    },

    // Check if a field name is a rest-field (variable-length array)
    isRestField(fieldName) {
        return fieldName.startsWith(REST_PREFIX);
    },

    // Get the base name of a field (strips '...' prefix if present)
    baseFieldName(fieldName) {
        return fieldName.startsWith(REST_PREFIX) ? fieldName.substring(REST_PREFIX.length) : fieldName;
    },

    // Determine which user-provided fields are "populated" (non-null, non-empty)
    getPopulatedFields(fields) {
        if (!fields || typeof fields !== 'object') return [];
        let populated = [];
        for (let key in fields) {
            let value = fields[key];
            if (value !== null && value !== undefined && value !== '')
                populated.push(key);
        }
        return populated;
    },

    /*
     * Read and shape-check the caller's per-leg array.
     *
     * Returns null when no LEGS were supplied (the flat single-leg call shape),
     * otherwise an array of leg objects. Throws on anything that is present but
     * not a usable leg list, so a mis-shaped multi-send fails at the SDK
     * boundary rather than reaching the wire as a valid-looking action.
     */
    getLegs(fields) {
        if (!fields || typeof fields !== 'object') return null;
        let legs = fields[LEGS_FIELD];
        if (legs === null || legs === undefined) return null;
        if (!Array.isArray(legs))
            throw new SDKFormatError('INVALID_LEGS', LEGS_FIELD + ' must be an array of per-leg objects', { legs });
        if (legs.length === 0)
            throw new SDKFormatError('INVALID_LEGS', LEGS_FIELD + ' must contain at least one leg', { legs });
        for (let i = 0; i < legs.length; i++) {
            let leg = legs[i];
            if (!leg || typeof leg !== 'object' || Array.isArray(leg))
                throw new SDKFormatError('INVALID_LEGS', LEGS_FIELD + '[' + i + '] must be an object of field values', { index: i, leg });
        }
        return legs;
    },

    // Value of a per-leg field: the leg's own value, falling back to a shared
    // top-level value (so a caller may hoist a constant TICK out of the legs)
    legFieldValue(fieldName, leg, fields, index) {
        let value = (leg[fieldName] !== null && leg[fieldName] !== undefined) ? leg[fieldName] : fields[fieldName];
        if (value === null || value === undefined) return '';
        if (Array.isArray(value))
            throw new SDKFormatError(
                'INVALID_LEGS',
                LEGS_FIELD + '[' + index + '].' + fieldName + ' must be a single value, not an array',
                { index, field: fieldName, value }
            );
        return String(value);
    },

    /*
     * Value of a shared (prefix/suffix) field of a repeated format.
     *
     * These occupy ONE wire slot for the whole action, so legs that disagree
     * cannot be represented: refuse instead of letting leg 1's value stand in
     * for every leg (the silent-overpay failure mode). A version whose group
     * covers the field is the caller's fix, and select() prefers it already.
     */
    sharedValue(fieldName, fields, legs, action, version) {
        let value = (fields[fieldName] !== null && fields[fieldName] !== undefined && fields[fieldName] !== '')
            ? fields[fieldName] : undefined;
        for (let i = 0; i < legs.length; i++) {
            let legValue = legs[i][fieldName];
            if (legValue === null || legValue === undefined || legValue === '') continue;
            if (value === undefined) { value = legValue; continue; }
            if (String(legValue) !== String(value))
                throw new SDKFormatError(
                    'INCONSISTENT_SHARED_FIELD',
                    action + ' v' + version + ' carries ' + fieldName + ' once for the whole action, but the legs disagree ('
                        + String(value) + ' vs ' + String(legValue) + '). Use a format version whose repeated group includes ' + fieldName + '.',
                    { action, version, field: fieldName, values: [String(value), String(legValue)], index: i }
                );
        }
        if (value === undefined) return '';
        if (Array.isArray(value))
            throw new SDKFormatError('INVALID_LEGS', fieldName + ' must be a single value, not an array', { field: fieldName, value });
        return String(value);
    },

    /*
     * Can this format version carry these legs without losing data?
     *
     * - single-leg format: only one leg, and every leg field has a slot
     * - repeated format: a leg field inside the group varies per leg freely;
     *   a leg field in the shared prefix/suffix only fits when every leg
     *   agrees on it (one wire slot). That is what makes SEND v1 (shared TICK)
     *   ineligible for two different ticks while v2 stays eligible.
     */
    legsFit(group, uniqueSlots, legs) {
        let legFields = new Set();
        for (let leg of legs)
            for (let key of Object.keys(leg))
                if (leg[key] !== null && leg[key] !== undefined && leg[key] !== '') legFields.add(key);

        for (let field of legFields)
            if (!uniqueSlots.includes(field)) return false;

        if (!group) return legs.length === 1;

        let perLeg = new Set(group.group);
        for (let field of legFields) {
            if (perLeg.has(field)) continue;
            // Shared slot: every leg that names it must agree
            let value;
            for (let leg of legs) {
                let v = leg[field];
                if (v === null || v === undefined || v === '') continue;
                if (value === undefined) { value = String(v); continue; }
                if (String(v) !== value) return false;
            }
        }
        return true;
    },

    // Merge a lone leg into the flat field map (leg values win) and drop LEGS,
    // so a single-leg format serializes identically whether the caller passed
    // flat fields or a one-entry legs array
    flattenSingleLeg(fields, leg) {
        let merged = Object.assign({}, fields, leg);
        delete merged[LEGS_FIELD];
        return merged;
    },

    // Field names a repeated format can carry (per-leg group + shared slots)
    repeatedFieldNames(group) {
        return new Set([...group.prefix, ...group.group, ...group.suffix].filter(f => !AUTO_FIELDS.includes(f)));
    },

    // Build the untrimmed value segments of a repeated-field format from legs.
    // parts[0] is the action name, exactly as the flat path builds it.
    buildRepeatedParts(action, version, fields, group, legs) {
        let known = this.repeatedFieldNames(group);
        for (let i = 0; i < legs.length; i++) {
            for (let key of Object.keys(legs[i])) {
                if (!known.has(key))
                    throw new SDKFormatError(
                        'LEG_FIELD_NOT_IN_FORMAT',
                        action + ' v' + version + ' has no slot for leg field ' + key,
                        { action, version, field: key, index: i, formatFields: [...known] }
                    );
            }
        }

        let parts = [action];
        for (let fieldName of group.prefix) {
            parts.push(fieldName === 'VERSION' ? String(version)
                : this.sharedValue(fieldName, fields, legs, action, version));
        }
        for (let i = 0; i < legs.length; i++) {
            for (let fieldName of group.group)
                parts.push(this.legFieldValue(fieldName, legs[i], fields, i));
        }
        for (let fieldName of group.suffix)
            parts.push(this.sharedValue(fieldName, fields, legs, action, version));
        return parts;
    }

};
