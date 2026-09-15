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

const formats = require('../formats.js');
const { CANONICAL_CARET_ID } = require('../../preflight/constants.js');
const { MAX_TICK_LENGTH, TICK_REGEX, TICK_REF_PREFIX, FORBIDDEN_TEXT_CHARS, DELIMITER_EXEMPT_FIELDS } = require('./field_limits.js');

module.exports = {
    _validateTickName(value, fields) {
        let errors = [];
        let name = String(value);

        // A caret-led ISSUE TICK is an INDEX REFERENCE, not a name, and consensus
        // judges the two by different rules, so they take different branches. Running
        // the name rules over `^12` refused every reference the chain resolves.
        if (name.startsWith(TICK_REF_PREFIX))
            return this._validateIssueTickRef(name, fields || {});

        if (name.length === 0 || name.length > MAX_TICK_LENGTH)
            errors.push(this._error('INVALID_TICK_NAME', 'TICK name must be 1-' + MAX_TICK_LENGTH + ' characters', { value, length: name.length }));

        if (!TICK_REGEX.test(name))
            errors.push(this._error('INVALID_TICK_NAME', 'TICK name contains invalid characters', { value, allowed: 'a-zA-Z0-9~!@#$%^&*()_+-={}[]:<>.?' }));

        for (let ch of FORBIDDEN_TEXT_CHARS) {
            if (name.includes(ch))
                errors.push(this._error('INVALID_TICK_NAME', 'TICK name cannot contain ' + (ch === '|' ? 'pipe (|)' : 'semicolon (;)'), { value }));
        }

        // Dot is the parent/child separator for sub-tokens (e.g. PARENT.CHILD), which the
        // indexer fully supports; use it as a separator but reject empty segments
        // (no leading, trailing, or consecutive dots). Slash is still forbidden.
        if (name.includes('.') && name.split('.').some(seg => seg.length === 0))
            errors.push(this._error('INVALID_TICK_NAME', 'TICK name has an empty parent/child segment (no leading, trailing, or consecutive dots)', { value }));
        if (name.includes('/'))
            errors.push(this._error('INVALID_TICK_NAME', 'TICK name cannot contain slash (/)', { value }));

        return errors;
    },

    /*
     * A caret-led ISSUE TICK, judged as the id reference it is.
     *
     * A caret id names an existing token exactly as the spelled-out name does: the
     * handler resolves both through the same call (xchain-indexer/src/actions/
     * issue.js:848-853 says so for format 7, and getTickerId is identical on every
     * format), so refusing every caret-led TICK unconditionally would block an
     * action consensus accepts. That is also why the ticker compactor holds
     * ISSUE.TICK out of TICK_REF_FIELDS.
     *
     * Two of the three rules bind on EVERY format, because the handler applies them
     * before it branches on one:
     *   - issue.js:349 refuses a non-numeric id, `invalid: TICK (id)`, with the same
     *     parseFloat-based isNumeric this calls;
     *   - issue.js:361 refuses a '.' inside the id, `invalid: TICK (caret dot)`, the
     *     shape isNumeric lets through (`^12.5` reads as a number) and which lands a
     *     valid ISSUE with a NULL ticker id below the flag-day.
     *
     * The third is GATED BY FORMAT, and that is the whole reason this takes `fields`.
     * Resolution itself is canonical-only: getTickerId (xchain-indexer/src/db/index_tables.js:375)
     * resolves a caret TICK only as /^[1-9][0-9]*$/ and only to a row that exists, so
     * `^007`, `^0` and `^-1` name nothing on any node. What the chain DOES about that
     * differs by format, so the client's verdict has to as well:
     *   - formats 6 and 7 refuse an unresolved tick outright (issue.js:782 and
     *     issue.js:828, `invalid: TICK (unknown)`), so a non-canonical caret is
     *     refused there on every plane at every height - below the token-bridge
     *     activation format 7 is `VERSION (unknown)` instead, which is still a refusal
     *     - and an error here false-blocks nothing;
     *   - formats 0 to 5 ACCEPT it (the handler falls through to createToken and
     *     registers a row with a NULL ticker id), so an error here would refuse an
     *     action consensus accepts, the false-block this validator's non-ISSUE ticker
     *     branch already refuses to commit.
     */
    _validateIssueTickRef(ref, fields) {
        let errors = [];
        let id     = ref.substring(1);

        // The handler measures the WHOLE wire tick, caret included (issue.js:365).
        if (ref.length > MAX_TICK_LENGTH)
            errors.push(this._error('INVALID_TICK_NAME', 'TICK must be 1-' + MAX_TICK_LENGTH + ' characters', { value: ref, length: ref.length }));

        // TICK opts out of the blanket delimiter guard in favour of this validation,
        // so the scan runs from inside it (the id rules below would catch '|' and ';'
        // as non-numeric, but the caller gets the delimiter's own code and message).
        errors.push(...this._scanDelimiters('TICK', ref));

        if (!this.util.isNumeric(id)) {
            errors.push(this._error('INVALID_TICK_ID',
                'TICK ID reference must be numeric: ' + ref, { field: 'TICK', value: ref }));
        } else if (id.includes('.')) {
            errors.push(this._error('INVALID_TICK_ID',
                'TICK ID reference cannot contain a dot: ' + ref + ' reads as a number but names no ticker id',
                { field: 'TICK', value: ref }));
        } else {
            let format = this._issueFormat(fields);
            if ((format === 6 || format === 7) && !CANONICAL_CARET_ID.test(id))
                errors.push(this._error('INVALID_TICK_ID',
                    'TICK ID reference ' + ref + ' is not a canonical ^<id> (no leading zero, id >= 1), so it '
                    + 'resolves on no node; ISSUE format ' + format + ' edits an existing token and the indexer '
                    + 'refuses it as an unknown TICK.',
                    { field: 'TICK', value: ref, version: format }));
        }

        return errors;
    },

    /*
     * The ISSUE format this action will be serialized as, or null when it cannot be
     * decided from the wire fields alone.
     *
     * An absent VERSION is auto-selected downstream (format_selector.js), so the two
     * formats whose caret rule is stricter are recovered from the fields only THEY
     * carry: BRIDGE_CHAINS / MIN_DEPTH / LOCK_BRIDGE appear on format 7 alone and the
     * controller fields on format 6 alone (issue.js:105-120). Anything else answers
     * null and takes the permissive branch, which is the safe direction: a missed
     * format costs a warning the chain will repeat, a wrong one costs a false block.
     */
    _issueFormat(fields) {
        if (!this._isEmpty(fields.VERSION)) {
            let version = Number(fields.VERSION);
            return Number.isInteger(version) ? version : null;
        }
        if (!this._isEmpty(fields.BRIDGE_CHAINS) || !this._isEmpty(fields.MIN_DEPTH)
            || !this._isEmpty(fields.LOCK_BRIDGE))
            return 7;
        if (!this._isEmpty(fields.CONTROLLER) || !this._isEmpty(fields.ACTION_CLASS)
            || !this._isEmpty(fields.UNBIND) || !this._isEmpty(fields.COOLDOWN_BLOCKS))
            return 6;
        return null;
    },

    // Default-deny delimiter guard. No serialized field value may contain the '|'
    // field separator or the ';' BATCH command separator (see DELIMITER_EXEMPT_FIELDS
    // for the handful that opt out). Handles string and array/rest-field values,
    // checking each element, so a corrupted roster/allow-list entry is caught too.
    _checkDelimiters(field, value) {
        if (DELIMITER_EXEMPT_FIELDS.has(field)) return [];
        return this._scanDelimiters(field, value);
    },

    // The scan itself, with no exemption check. Split out so a field that opts out
    // of the blanket guard can still be scanned from inside the validation it opted
    // out IN FAVOUR OF, and report the same code and message as every other field.
    _scanDelimiters(field, value) {
        let errors = [];
        let items = Array.isArray(value) ? value : [value];
        for (let item of items) {
            if (this._isEmpty(item)) continue;
            let text = String(item);
            for (let ch of FORBIDDEN_TEXT_CHARS) {
                if (text.includes(ch))
                    errors.push(this._error('FORBIDDEN_CHARACTER',
                        field + ' cannot contain ' + (ch === '|' ? 'pipe (|)' : 'semicolon (;)'),
                        { field, value: item }));
            }
        }
        return errors;
    },

    _isEmpty(value) {
        return value === null || value === undefined || value === '';
    },

    _error(code, message, details = {}) {
        return { code, message, details };
    }
};
