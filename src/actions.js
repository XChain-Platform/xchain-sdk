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
 * XChain Platform SDK - Actions Class
 *
 * This file handles generating action strings from user input
 *
 ********************************************************************/

const FormatSelector    = require('./formatSelector.js');
const Validator         = require('./validator.js');
const { getNetwork }    = require('./networks.js');
const { SDKValidationError, SDKContractError } = require('./errors.js');

// Encoding byte limits for pre-flight validation
const ENCODING_LIMITS = {
    OP_RETURN:  76,   // 80 - 4 byte magic word (XCHN)
    MULTISIGN:  60,   // 60 bytes of data per chunk (data split across 2 fake pubkeys)
    P2SH:       476,  // 520 - 44 byte script overhead
    P2WSH:      476   // 520 - 44 byte script overhead per chunk (MAX_SCRIPT_ELEMENT_SIZE bound)
};

// Compiled script-push length for a payload of `n` bytes. The on-chain
// OP_RETURN payload is `bitcoin.script.compile([bytes])`, whose push prefix
// grows with size: direct push (<=75B) adds 1, OP_PUSHDATA1 (76..255) adds 2,
// OP_PUSHDATA2 (>255) adds 3. The encoder gates on THIS compiled length, so
// the pre-flight must too: a bare byte-length check under-rejects at the
// boundary and accepts action strings the encoder then throws RangeError on.
function compiledPushSize(n) {
    return n <= 75 ? n + 1 : n <= 255 ? n + 2 : n + 3;
}


class Actions {

    constructor(sdk) {
        this.config    = sdk.config;
        this.util      = sdk.util;
        this.actions   = this.util.getActions();
        this.validator = new Validator(this.util);
        // Resolved network name, used only to keep oversized-payload encoding
        // suggestions network-aware (non-segwit chains cannot use P2WSH). Absent
        // on a bare {config, util} shim; treated as segwit-capable (unchanged).
        this.network   = (sdk.options && sdk.options.network) || process.env.NETWORK || null;
    }

    // Whether the resolved network supports segwit encodings (P2WSH). Fails
    // open to `true` when the network is unset or unrecognized so the common
    // segwit path is unchanged; only a network explicitly marked
    // supportsSegwit:false (e.g. DOGE) flips this to false.
    _supportsSegwit() {
        if (!this.network) return true;
        try { return getNetwork(this.network).supportsSegwit !== false; }
        catch (e) { return true; }
    }

    /**
     * The pure { action, params } -> wire-string core: steps [1] through [7],
     * no network and no encoder. Shared with `sdk.preflight`, which used to
     * re-implement a SUBSET of it and silently forgot a behaviour each time
     * one was added here (camelCase normalization, then params-level VERSION
     * lifting, and LEGS was next in line). Two copies of "how params become a
     * wire string" is how a pre-flight verdict ends up describing a different
     * action than the one that would broadcast.
     *
     * `validate` is the ONE deliberate difference between the two callers, and
     * it is a parameter rather than a divergence: compose throws on invalid
     * fields, pre-flight does not, because its contract is to REPORT problems
     * as findings so a headless consumer still gets a verdict (spec §4.2).
     *
     * Accepts `fields` as an alias for `params`, the shape createAction's own
     * result carries, so a result can be fed straight back in.
     */
    composeActionString(data, { validate = true } = {}) {
        // [1] Validate request structure
        if (!data || !data.action)
            throw new SDKValidationError('MISSING_ACTION', 'Request must include an action field');

        let actionName = String(data.action).toUpperCase();
        let params     = data.params || data.fields || {};

        // [2] Validate ACTION type exists
        if (!this.actions.includes(actionName))
            throw new SDKValidationError('UNKNOWN_ACTION', 'Unknown ACTION type: ' + actionName, { action: actionName, validActions: this.actions });

        // [3] Normalize field names (camelCase -> UPPER_SNAKE_CASE)
        let fields = this.util.normalizeFields(params);

        // [3b] DEPLOY pre-processing: base64-encode raw 'code' into CODE_ENCODING.
        // base64 (1.33x) instead of hex (2x): the action string is pipe-delimited and
        // base64's alphabet (A-Za-z0-9+/=) has no '|', so it stays delimiter-safe while
        // cutting the on-chain payload by a third (lifts the single-tx contract ceiling).
        if (actionName === 'DEPLOY' && fields.CODE !== undefined && fields.CODE !== null && fields.CODE_ENCODING === undefined) {
            let code = String(fields.CODE);
            fields.CODE_ENCODING = Buffer.from(code, 'utf8').toString('base64');
            delete fields.CODE;
        }

        // [3c] EXECUTE/DEPLOY: ensure PARAMS/CONSTRUCTOR_PARAMS stay as arrays (skip number casting)
        if (actionName === 'EXECUTE' && fields.PARAMS !== undefined) {
            if (!Array.isArray(fields.PARAMS))
                fields.PARAMS = [String(fields.PARAMS)];
            else
                fields.PARAMS = fields.PARAMS.map(p => String(p));
        }
        if (actionName === 'DEPLOY' && fields.CONSTRUCTOR_PARAMS !== undefined) {
            if (!Array.isArray(fields.CONSTRUCTOR_PARAMS))
                fields.CONSTRUCTOR_PARAMS = [String(fields.CONSTRUCTOR_PARAMS)];
            else
                fields.CONSTRUCTOR_PARAMS = fields.CONSTRUCTOR_PARAMS.map(p => String(p));
        }

        // [3d] LIST: ITEM is a rest-field; coerce to an array of strings so a
        // multi-item list serializes as individual pipe segments (a lone string
        // stays a single-item list, preserving the old call shape)
        if (actionName === 'LIST' && fields.ITEM !== undefined && fields.ITEM !== null) {
            if (!Array.isArray(fields.ITEM))
                fields.ITEM = [String(fields.ITEM)];
            else
                fields.ITEM = fields.ITEM.map(i => String(i));
        }

        // [3e] LEGS (multi-destination SEND, multi-tick DESTROY/AIRDROP): each
        // leg is its own field map, so it needs the same camelCase->UPPER_SNAKE
        // and numeric normalization the top-level map gets. Mis-shaped entries
        // pass through untouched for the validator to report.
        fields = this._normalizeLegs(fields);

        // [4] Cast numeric fields
        fields = this.util.setNumberFormats(fields);

        // [5] Validate fields against action-specific rules.
        // Skipped for pre-flight: see the `validate` note on this method.
        if (validate) this.validator.validateOrThrow(actionName, fields);

        // [6] Select optimal format version
        // Callers may force a specific version by passing `version` in params (e.g. STAKE v1 vs v2).
        // VERSION is otherwise an auto-field set by the selector from the format key.
        let explicitVersion = undefined;
        if (fields.VERSION !== undefined && fields.VERSION !== null && fields.VERSION !== '') {
            explicitVersion = fields.VERSION;
            delete fields.VERSION;
        }
        // A top-level `version` is the same request spelled the other way, and
        // pre-flight callers spell it that way. Honoured here so both entry
        // points read it identically; a params-level VERSION still wins.
        if (explicitVersion === undefined && data.version !== undefined && data.version !== null && data.version !== '')
            explicitVersion = data.version;
        let selected = FormatSelector.select(actionName, fields, explicitVersion);

        // [6b] DEPLOY stakeable formats (v1/v3) carry CONSTRUCTOR_PARAMS as a
        // single plain field, unlike the rest-field ('...CONSTRUCTOR_PARAMS')
        // v0/v2 formats. serialize() String()-joins an array pushed into a
        // plain field, so ['alice','1000'] would silently reach the wire as
        // one comma-joined segment ('alice,1000') and the indexer/VM would
        // hand the contract constructor ONE corrupted arg on an immutable
        // deploy. Fail loudly instead. Keyed off the selected format's field
        // shape (plain vs rest), not hard-coded version numbers, so it stays
        // correct if the format list evolves.
        if (actionName === 'DEPLOY'
            && Array.isArray(fields.CONSTRUCTOR_PARAMS) && fields.CONSTRUCTOR_PARAMS.length > 1
            && selected.formatFields.includes('CONSTRUCTOR_PARAMS')) {
            throw new SDKValidationError(
                'INVALID_FIELD_VALUE',
                'DEPLOY v' + selected.version + ' (stakeable) carries CONSTRUCTOR_PARAMS as a single wire field and accepts at most one entry; got ' + fields.CONSTRUCTOR_PARAMS.length + '. Pack multiple values into one param your constructor parses, or use a non-stakeable format (v0/v2).',
                { field: 'CONSTRUCTOR_PARAMS', action: actionName, version: selected.version, count: fields.CONSTRUCTOR_PARAMS.length }
            );
        }

        // [7] Serialize to pipe-delimited string
        let actionString = FormatSelector.serialize(actionName, selected.version, fields);

        return {
            action:       actionName,
            version:      selected.version,
            actionString: actionString,
            fields:       fields
        };
    }

    // Main entry point: create an action string from user input
    // data = { action: 'SEND', params: { tick, amount, destination, memo }, encoder: { ... } }
    createAction(data) {
        let composed = this.composeActionString(data);
        let encoder  = data.encoder || null;

        // [8] Pre-flight encoding validation (if encoder options provided)
        if (encoder && encoder.encoding) {
            this._validateEncoding(composed.actionString, encoder);
        }

        // [9] Build result
        return {
            action:       composed.action,
            version:      composed.version,
            actionString: composed.actionString,
            fields:       composed.fields,
            encoding:     null,
            psbt:         null
        };
    }

    // Normalize each entry of the per-leg array in place of the caller's copy
    _normalizeLegs(fields) {
        let legs = fields[FormatSelector.LEGS_FIELD];
        if (!Array.isArray(legs)) return fields;
        fields[FormatSelector.LEGS_FIELD] = legs.map(leg => {
            if (!leg || typeof leg !== 'object' || Array.isArray(leg)) return leg;
            return this.util.setNumberFormats(this.util.normalizeFields(leg));
        });
        return fields;
    }

    // Pre-flight validation of encoding choice against action string size
    _validateEncoding(actionString, encoder) {
        let encoding  = String(encoder.encoding).toUpperCase();
        let dataBytes = Buffer.byteLength(actionString, 'utf8');

        if (encoding === 'OP_RETURN') {
            // Gate on the COMPILED push size (payload + push prefix + 4-byte
            // magic), the exact quantity the encoder enforces. A 75-byte action
            // string compiles to 76 (direct push) and fits; 76 bytes compiles to
            // 78 (OP_PUSHDATA1) and the encoder rejects it. The action-string
            // ceiling is therefore 75 bytes, not 76.
            if (compiledPushSize(dataBytes) + 4 > 80) {
                // Non-segwit chains (DOGE) cannot use P2WSH; suggest P2SH there.
                let suggestion = dataBytes <= ENCODING_LIMITS.P2SH ? 'P2SH'
                    : (this._supportsSegwit() ? 'P2WSH' : 'P2SH');
                throw new SDKValidationError(
                    'ENCODING_DATA_TOO_LARGE',
                    'ACTION string is ' + dataBytes + ' bytes but OP_RETURN supports max 75 bytes of action data once compiled (80 - 4 byte magic word - push prefix). Use ' + suggestion + ' or omit encoding for auto-selection.',
                    { encoding, dataBytes, maxBytes: 75, suggestion }
                );
            }
        }

        if (encoding === 'MULTISIGN') {
            if (!encoder.compressedPubKey) {
                throw new SDKValidationError(
                    'MISSING_COMPRESSED_PUBKEY',
                    'MULTISIGN encoding requires compressedPubKey in encoder options.',
                    { encoding }
                );
            }
        }
    }

    // Validate an action without building the string (dry-run)
    validateAction(action, params) {
        let actionName = String(action).toUpperCase();
        let fields     = this.util.normalizeFields(params || {});
        fields         = this._normalizeLegs(fields);
        fields         = this.util.setNumberFormats(fields);
        let errors     = this.validator.validate(actionName, fields);
        if (errors.length === 0)
            return { valid: true, errors: [] };
        return { valid: false, errors };
    }

    // Introspection: list all supported action names
    getActions() {
        return this.actions;
    }

    // Introspection: get format versions for an action
    getActionFormats(action) {
        return this.util.getActionFormats(action);
    }

    // Introspection: get field list for an action + optional version
    getActionFields(action, version) {
        let actionName = String(action).toUpperCase();
        if (version !== undefined && version !== null) {
            return this.util.getActionFormatFieldList(actionName, version);
        }
        // Union of all versions
        let allFormats = this.util.getActionFormats(actionName);
        if (!allFormats) return [];
        let allFields = new Set();
        for (let v in allFormats) {
            let fields = this.util.getActionFormatFieldList(actionName, parseInt(v));
            for (let f of fields) allFields.add(f);
        }
        return [...allFields];
    }

}

module.exports = Actions;
