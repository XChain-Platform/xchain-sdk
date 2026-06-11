/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
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
const { SDKValidationError, SDKContractError } = require('./errors.js');

// Encoding byte limits for pre-flight validation
const ENCODING_LIMITS = {
    OP_RETURN:  76,   // 80 - 4 byte magic word (XCHN)
    MULTISIGN:  61,   // ~61 bytes per chunk (data split across 2 fake pubkeys)
    P2SH:       476,  // 520 - 44 byte script overhead
    P2WSH:      9956  // 10000 - 44 byte script overhead
};


class Actions {

    constructor(sdk) {
        this.config    = sdk.config;
        this.util      = sdk.util;
        this.actions   = this.util.getActions();
        this.validator = new Validator(this.util);
    }

    // Main entry point: create an action string from user input
    // data = { action: 'SEND', params: { tick, amount, destination, memo }, encoder: { ... } }
    createAction(data) {
        // [1] Validate request structure
        if (!data || !data.action)
            throw new SDKValidationError('MISSING_ACTION', 'Request must include an action field');

        let actionName = String(data.action).toUpperCase();
        let params     = data.params || {};
        let encoder    = data.encoder || null;

        // [2] Validate ACTION type exists
        if (!this.actions.includes(actionName))
            throw new SDKValidationError('UNKNOWN_ACTION', 'Unknown ACTION type: ' + actionName, { action: actionName, validActions: this.actions });

        // [3] Normalize field names (camelCase -> UPPER_SNAKE_CASE)
        let fields = this.util.normalizeFields(params);

        // [3b] DEPLOY pre-processing: hex-encode raw 'code' into CODE_ENCODING
        if (actionName === 'DEPLOY' && fields.CODE !== undefined && fields.CODE !== null && fields.CODE_ENCODING === undefined) {
            let code = String(fields.CODE);
            fields.CODE_ENCODING = Buffer.from(code, 'utf8').toString('hex');
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

        // [3d] LIST: ITEM is a rest-field — coerce to an array of strings so a
        // multi-item list serializes as individual pipe segments (a lone string
        // stays a single-item list, preserving the old call shape)
        if (actionName === 'LIST' && fields.ITEM !== undefined && fields.ITEM !== null) {
            if (!Array.isArray(fields.ITEM))
                fields.ITEM = [String(fields.ITEM)];
            else
                fields.ITEM = fields.ITEM.map(i => String(i));
        }

        // [4] Cast numeric fields
        fields = this.util.setNumberFormats(fields);

        // [5] Validate fields against action-specific rules
        this.validator.validateOrThrow(actionName, fields);

        // [6] Select optimal format version
        // Callers may force a specific version by passing `version` in params (e.g. STAKE v1 vs v2).
        // VERSION is otherwise an auto-field set by the selector from the format key.
        let explicitVersion = undefined;
        if (fields.VERSION !== undefined && fields.VERSION !== null && fields.VERSION !== '') {
            explicitVersion = fields.VERSION;
            delete fields.VERSION;
        }
        let selected = FormatSelector.select(actionName, fields, explicitVersion);

        // [7] Serialize to pipe-delimited string
        let actionString = FormatSelector.serialize(actionName, selected.version, fields);

        // [8] Pre-flight encoding validation (if encoder options provided)
        if (encoder && encoder.encoding) {
            this._validateEncoding(actionString, encoder);
        }

        // [9] Build result
        let result = {
            action:       actionName,
            version:      selected.version,
            actionString: actionString,
            fields:       fields,
            encoding:     null,
            psbt:         null
        };

        return result;
    }

    // Pre-flight validation of encoding choice against action string size
    _validateEncoding(actionString, encoder) {
        let encoding  = String(encoder.encoding).toUpperCase();
        let dataBytes = Buffer.byteLength(actionString, 'utf8');

        if (encoding === 'OP_RETURN') {
            if (dataBytes + 4 > 80) {
                let suggestion = dataBytes <= ENCODING_LIMITS.P2SH ? 'P2SH' : 'P2WSH';
                throw new SDKValidationError(
                    'ENCODING_DATA_TOO_LARGE',
                    'ACTION string is ' + dataBytes + ' bytes but OP_RETURN supports max ' + ENCODING_LIMITS.OP_RETURN + ' bytes of data (80 - 4 byte magic word). Use ' + suggestion + ' or omit encoding for auto-selection.',
                    { encoding, dataBytes, maxBytes: ENCODING_LIMITS.OP_RETURN, suggestion }
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
