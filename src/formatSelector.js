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
const { SDKFormatError } = require('./errors.js');

// VERSION is always auto-set by the SDK, never user-provided
const AUTO_FIELDS = ['VERSION'];

// Rest-field prefix: fields starting with '...' absorb variable-length array values
const REST_PREFIX = '...';

// Caller-facing field carrying the per-leg array of a repeated-field format
// (multi-destination SEND, multi-tick DESTROY/AIRDROP). Not a wire field: it
// expands positionally into the format's repeated group.
const LEGS_FIELD = 'LEGS';

// Memoized repeated-group decompositions, keyed 'ACTION|VERSION'. `null` is a
// cached "no repeat" answer, so the derivation runs once per format.
const GROUP_CACHE = new Map();


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
    static getRepeatedGroup(action, version) {
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
    }

    // Whether a format carries a repeated per-leg group (multi-leg SEND etc.)
    static isRepeatedFormat(action, version) {
        return this.getRepeatedGroup(action, version) !== null;
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

    /*
     * Read and shape-check the caller's per-leg array.
     *
     * Returns null when no LEGS were supplied (the flat single-leg call shape),
     * otherwise an array of leg objects. Throws on anything that is present but
     * not a usable leg list, so a mis-shaped multi-send fails at the SDK
     * boundary rather than reaching the wire as a valid-looking action.
     */
    static getLegs(fields) {
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
    }

    // Value of a per-leg field: the leg's own value, falling back to a shared
    // top-level value (so a caller may hoist a constant TICK out of the legs)
    static _legValue(fieldName, leg, fields, index) {
        let value = (leg[fieldName] !== null && leg[fieldName] !== undefined) ? leg[fieldName] : fields[fieldName];
        if (value === null || value === undefined) return '';
        if (Array.isArray(value))
            throw new SDKFormatError(
                'INVALID_LEGS',
                LEGS_FIELD + '[' + index + '].' + fieldName + ' must be a single value, not an array',
                { index, field: fieldName, value }
            );
        return String(value);
    }

    /*
     * Value of a shared (prefix/suffix) field of a repeated format.
     *
     * These occupy ONE wire slot for the whole action, so legs that disagree
     * cannot be represented: refuse instead of letting leg 1's value stand in
     * for every leg (the silent-overpay failure mode). A version whose group
     * covers the field is the caller's fix, and select() prefers it already.
     */
    static _sharedValue(fieldName, fields, legs, action, version) {
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
    }

    /*
     * Can this format version carry these legs without losing data?
     *
     * - single-leg format: only one leg, and every leg field has a slot
     * - repeated format: a leg field inside the group varies per leg freely;
     *   a leg field in the shared prefix/suffix only fits when every leg
     *   agrees on it (one wire slot). That is what makes SEND v1 (shared TICK)
     *   ineligible for two different ticks while v2 stays eligible.
     */
    static _legsFit(group, uniqueSlots, legs) {
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
    }

    // Merge a lone leg into the flat field map (leg values win) and drop LEGS,
    // so a single-leg format serializes identically whether the caller passed
    // flat fields or a one-entry legs array
    static _flattenSingleLeg(fields, leg) {
        let merged = Object.assign({}, fields, leg);
        delete merged[LEGS_FIELD];
        return merged;
    }

    // Field names a repeated format can carry (per-leg group + shared slots)
    static _repeatedFieldNames(group) {
        return new Set([...group.prefix, ...group.group, ...group.suffix].filter(f => !AUTO_FIELDS.includes(f)));
    }

    // Build the untrimmed value segments of a repeated-field format from legs.
    // parts[0] is the action name, exactly as the flat path builds it.
    static _buildRepeatedParts(action, version, fields, group, legs) {
        let known = this._repeatedFieldNames(group);
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
                : this._sharedValue(fieldName, fields, legs, action, version));
        }
        for (let i = 0; i < legs.length; i++) {
            for (let fieldName of group.group)
                parts.push(this._legValue(fieldName, legs[i], fields, i));
        }
        for (let fieldName of group.suffix)
            parts.push(this._sharedValue(fieldName, fields, legs, action, version));
        return parts;
    }

    // Estimate the serialized length of an action string for a given format version
    static estimateLength(action, version, fields) {
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
            let v = Number(explicitVersion);
            if (!formats[action][v])
                throw new SDKFormatError(
                    'INVALID_VERSION',
                    'Version ' + v + ' is not defined for ' + action,
                    { action, version: v, availableVersions: Object.keys(formats[action]) }
                );
            return {
                version:         v,
                formatFields:    this.getFormatFields(action, v),
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

    // Serialize an action + version + fields into a pipe-delimited action string
    static serialize(action, version, fields) {
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

}

module.exports = FormatSelector;
