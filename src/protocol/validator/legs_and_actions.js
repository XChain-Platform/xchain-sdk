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
const FormatSelector = require('../format_selector.js');
const { LEGS_FIELD } = require('./field_limits.js');

module.exports = {
    // The caller's per-leg array, or null when this is a flat single-leg call.
    // Shape problems are reported by validateLegsShape, not thrown here.
    legsOf(fields) {
        let legs = fields[LEGS_FIELD];
        if (!Array.isArray(legs) || legs.length === 0) return null;
        if (!legs.every(leg => leg && typeof leg === 'object' && !Array.isArray(leg))) return null;
        return legs;
    },

    // Tag a per-leg finding with its leg index so the caller can point at the
    // offending recipient rather than the whole action
    withLeg(error, index) {
        error.message = error.message + ' (leg ' + index + ')';
        error.details = Object.assign({}, error.details, { leg: index });
        return error;
    },

    /*
     * LEGS shape rules. LEGS is the caller-side representation of a
     * repeated-field format (multi-destination SEND, multi-tick
     * DESTROY/AIRDROP); it is not a wire field, so its only job is to be a
     * usable array of per-leg field maps. Whether a given format VERSION can
     * carry these legs is FormatSelector's call, not the validator's.
     */
    validateLegsShape(action, fields) {
        let errors = [];
        let legs   = fields[LEGS_FIELD];
        if (legs === null || legs === undefined) return errors;

        if (!Array.isArray(legs)) {
            errors.push(this.buildError('INVALID_LEGS', LEGS_FIELD + ' must be an array of per-leg objects', { action, field: LEGS_FIELD }));
            return errors;
        }
        if (legs.length === 0) {
            errors.push(this.buildError('INVALID_LEGS', LEGS_FIELD + ' must contain at least one leg', { action, field: LEGS_FIELD }));
            return errors;
        }
        for (let i = 0; i < legs.length; i++) {
            let leg = legs[i];
            if (!leg || typeof leg !== 'object' || Array.isArray(leg)) {
                errors.push(this.buildError('INVALID_LEGS', LEGS_FIELD + '[' + i + '] must be an object of field values', { action, field: LEGS_FIELD, leg: i }));
                continue;
            }
            for (let key in leg) {
                if (Array.isArray(leg[key]) || (leg[key] !== null && typeof leg[key] === 'object'))
                    errors.push(this.buildError('INVALID_LEGS', LEGS_FIELD + '[' + i + '].' + key + ' must be a single scalar value', { action, field: key, leg: i }));
            }
        }

        // Multi-leg only makes sense for an action with a repeated-field
        // format; anything else would silently drop every leg past the first.
        if (legs.length > 1) {
            let repeatable = Object.keys(formats[action] || {})
                .some(v => FormatSelector.isRepeatedFormat(action, parseInt(v)));
            if (!repeatable)
                errors.push(this.buildError('INVALID_LEGS',
                    action + ' has no multi-leg format version; ' + LEGS_FIELD + ' must contain exactly one leg',
                    { action, field: LEGS_FIELD, legCount: legs.length }));
        }

        return errors;
    },

    validateAction(action, fields) {
        let errors = [];

        switch (action) {
            case 'ADDRESS':
                // ISSUE v6 / ADDRESS v1 controller bind/unbind cross-field rules (no-op for a
                // plain ISSUE/ADDRESS that carries no controller fields).
                errors.push(...this.validateControllerBind(fields));
                break;
            case 'ISSUE':
                errors.push(...this.validateControllerBind(fields));
                // ISSUE v7 bridge opt-in cross-field rules (no-op for every other format).
                errors.push(...this.validateBridgeOptIn(fields));
                break;
            case 'BATCH':
                errors.push(...this.validateBatchFields(fields));
                break;
            case 'BET':
                errors.push(...this.validateBetFields(fields));
                break;
            case 'BROADCAST':
                errors.push(...this.validateBroadcast(fields));
                break;
            case 'DELEGATE':
                errors.push(...this.validateDelegate(fields));
                break;
            case 'DEPLOY':
                errors.push(...this.validateDeploy(fields));
                break;
            case 'DISPENSER':
                errors.push(...this.validateDispenser(fields));
                break;
            case 'LIST':
                errors.push(...this.validateList(fields));
                break;
            case 'ORDER':
                errors.push(...this.validateOrder(fields));
                break;
            case 'SWAP':
                errors.push(...this.validateSwap(fields));
                break;
            case 'VOTE':
                errors.push(...this.validateVote(fields));
                break;
        }

        return errors;
    },

    // Controller bind/unbind cross-field rules (ISSUE v6 token controller / ADDRESS v1 account
    // controller). Only applies when controller fields are present; a plain ISSUE/ADDRESS is
    // unaffected. Stateless client-side pre-check only (the indexer owns "already bound", contract
    // existence, etc.). UNBIND=1 drops a binding (CONTROLLER then ignored); a bind requires CONTROLLER.
    validateControllerBind(fields) {
        let errors = [];
        let hasController = !this.util.isNull(fields['CONTROLLER']);
        let hasClass      = !this.util.isNull(fields['ACTION_CLASS']);
        let hasUnbind     = !this.util.isNull(fields['UNBIND']);
        // Not a controller bind at all - nothing to check.
        if (!hasController && !hasClass && !hasUnbind)
            return errors;
        let isUnbind = Number(fields['UNBIND']) === 1;
        if (!hasClass)
            errors.push(this.buildError('MISSING_REQUIRED_FIELD', 'ACTION_CLASS is required for a controller bind/unbind', { field: 'ACTION_CLASS' }));
        if (!isUnbind && !hasController)
            errors.push(this.buildError('MISSING_REQUIRED_FIELD', 'CONTROLLER is required to bind a controller', { field: 'CONTROLLER' }));
        return errors;
    },

    /*
     * ISSUE v7 (the issuer's bridge opt-in) cross-field rules.
     *
     * One refusal is decidable with nothing but the wire fields: the indexer refuses the
     * WHOLE format for a dotted name (xchain-indexer/src/actions/issue.js:855,
     * 'invalid: TICK (subassets are not bridgeable yet)'). A bridged row is created one
     * level under its origin chain's root, and the bridge creates exactly that one level,
     * so a dotted native name would strand the in-leg on the parent gate AFTER the origin
     * escrow was already debited. Refusing the opt-in is what stops such a token from ever
     * being advertised as bridgeable.
     *
     * The handler judges the RESOLVED name, so a '^id' reference to a dotted row is refused
     * on chain and cannot be seen from here; that half, like the unknown-tick and the
     * LOCK_BRIDGE=1 frozen-field refusals, needs the token row and lives in
     * src/preflight/checks/issue.js. Nothing is asserted about it here rather than guessed.
     */
    validateBridgeOptIn(fields) {
        let errors = [];
        // An absent VERSION is auto-selected downstream, and BRIDGE_CHAINS / MIN_DEPTH /
        // LOCK_BRIDGE appear on format 7 alone, so carrying one of them IS this format.
        let version = this.isEmpty(fields.VERSION) ? null : Number(fields.VERSION);
        if (version === null) {
            let carriesBridgeField = !this.isEmpty(fields['BRIDGE_CHAINS'])
                || !this.isEmpty(fields['MIN_DEPTH'])
                || !this.isEmpty(fields['LOCK_BRIDGE']);
            if (!carriesBridgeField) return errors;
        } else if (version !== 7) {
            return errors;
        }
        let tick = this.isEmpty(fields['TICK']) ? '' : String(fields['TICK']);
        if (tick.charAt(0) !== '^' && tick.includes('.'))
            errors.push(this.buildError('ISSUE_CONSTRAINT',
                'subassets are not bridgeable yet, so the indexer refuses the ISSUE v7 bridge opt-in for ' + tick,
                { action: 'ISSUE', version: 7, field: 'TICK', value: tick }));
        return errors;
    },

    validateBroadcast(fields) {
        let errors = [];
        // Must have either MESSAGE or BROADCAST_ACTION_INDEX
        if (this.isEmpty(fields.MESSAGE) && this.isEmpty(fields.BROADCAST_ACTION_INDEX))
            errors.push(this.buildError('MISSING_REQUIRED_FIELD', 'BROADCAST requires MESSAGE or BROADCAST_ACTION_INDEX'));
        return errors;
    }
};
