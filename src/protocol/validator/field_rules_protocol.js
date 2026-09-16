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

const { MAX_DEPLOYCHUNK_PART_BYTES } = require('../../contract/chunk_helper.js');
const {
    MAX_CODE_SIZE,
    FORBIDDEN_TEXT_CHARS,
} = require('./field_limits.js');

// Applies one contiguous field-rule group while preserving finding order.
function validateBlockFields(validator, action, field, value, allFields, errors) {
    if (field === 'RESUME_BLOCK' || field === 'CALLBACK_BLOCK' ||
        field === 'MINT_START_BLOCK' || field === 'MINT_STOP_BLOCK') {
        if (!validator.util.isNumeric(value))
            errors.push(validator.buildError('INVALID_FIELD_VALUE', field + ' must be numeric', { field, value }));
    }
}

// Applies one contiguous field-rule group while preserving finding order.
function validateActionIndexFields(validator, action, field, value, allFields, errors) {
    // ACTION_INDEX fields must be numeric
    if (field === 'BROADCAST_ACTION_INDEX' || field === 'DISPENSER_ACTION_INDEX' ||
        field === 'ORDER_ACTION_INDEX' || field === 'SWAP_ACTION_INDEX' ||
        field === 'LIST_ACTION_INDEX' || field === 'COIN1_ACTION_INDEX' ||
        field === 'COIN2_ACTION_INDEX' || field === 'CONTRACT_ACTION_INDEX') {
        if (!validator.util.isNumeric(value))
            errors.push(validator.buildError('INVALID_FIELD_VALUE', field + ' must be numeric', { field, value }));
    }
}

// Applies one contiguous field-rule group while preserving finding order.
function validateGasLimit(validator, action, field, value, allFields, errors) {
    // GAS_LIMIT validation (must be positive integer)
    if (field === 'GAS_LIMIT') {
        if (!validator.util.isNumeric(value) || Number(value) <= 0 || !Number.isInteger(Number(value)))
            errors.push(validator.buildError('INVALID_FIELD_VALUE', 'GAS_LIMIT must be a positive integer', { field, value }));
    }
}

// Applies one contiguous field-rule group while preserving finding order.
function validateQuantity(validator, action, field, value, allFields, errors) {
    // QUANTITY validation (must be numeric and positive)
    if (field === 'QUANTITY') {
        if (!validator.util.isNumeric(value) || Number(value) <= 0)
            errors.push(validator.buildError('INVALID_FIELD_VALUE', 'QUANTITY must be a positive number', { field, value }));
    }
}

// Applies one contiguous field-rule group while preserving finding order.
function validateVoteAmounts(validator, action, field, value, allFields, errors) {
    // VOTE v0 binding-poll numeric fields. Consensus (indexer actions/vote.js)
    // requires DEPOSIT and GAS_ESCROW to be non-negative amounts and
    // CALLBACK_CONTRACT to be numeric (a contract ACTION_INDEX, resolved via
    // parseInt); check the same shape client-side so a bad value fails before
    // broadcast instead of producing an on-chain invalid action.
    if (field === 'DEPOSIT' || field === 'GAS_ESCROW') {
        if (!validator.util.isNumeric(value) || Number(value) < 0)
            errors.push(validator.buildError('INVALID_FIELD_VALUE', field + ' must be a non-negative number', { field, value, constraint: { min: 0 } }));
    }
}

// Applies one contiguous field-rule group while preserving finding order.
function validateCallbackContract(validator, action, field, value, allFields, errors) {
    if (field === 'CALLBACK_CONTRACT') {
        if (!/^[0-9]+$/.test(String(value)))
            errors.push(validator.buildError('INVALID_FIELD_VALUE', 'CALLBACK_CONTRACT must be a non-negative integer (a contract ACTION_INDEX)', { field, value }));
    }
}

// Applies one contiguous field-rule group while preserving finding order.
function validateCallbackDelay(validator, action, field, value, allFields, errors) {
    if (field === 'CALLBACK_DELAY_BLOCKS') {
        if (!/^[0-9]+$/.test(String(value)))
            errors.push(validator.buildError('INVALID_FIELD_VALUE', 'CALLBACK_DELAY_BLOCKS must be a non-negative integer (blocks between finalize and the callback firing)', { field, value }));
    }
}

// Applies one contiguous field-rule group while preserving finding order.
function validateMethod(validator, action, field, value, allFields, errors) {
    // METHOD validation (non-empty; delimiter safety via checkDelimiters)
    if (field === 'METHOD') {
        if (typeof value !== 'string' || value.length === 0)
            errors.push(validator.buildError('INVALID_FIELD_VALUE', 'METHOD must be a non-empty string', { field, value }));
    }
}

// Applies one contiguous field-rule group while preserving finding order.
function validateCodeEncoding(validator, action, field, value, allFields, errors) {
    // CODE_ENCODING validation (base64 string, decoded-size limit)
    if (field === 'CODE_ENCODING') {
        let b64 = String(value);
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
            errors.push(validator.buildError('INVALID_FIELD_VALUE', 'CODE_ENCODING must be a valid base64 string', { field }));
        } else {
            let bytes = Buffer.from(b64, 'base64').length; // decoded source size
            if (bytes > MAX_CODE_SIZE)
                errors.push(validator.buildError('CODE_TOO_LARGE', 'Contract code exceeds ' + MAX_CODE_SIZE + ' byte limit (' + bytes + ' bytes)', { field, bytes, limit: MAX_CODE_SIZE }));
        }
    }
}

// Applies one contiguous field-rule group while preserving finding order.
function validateCodeHash(validator, action, field, value, allFields, errors) {
    // CODE_HASH validation: DEPLOY v2/v3 assemble + v4 carrier group key (sha256 hex)
    if (field === 'CODE_HASH') {
        if (!/^[0-9a-f]{64}$/.test(String(value)))
            errors.push(validator.buildError('INVALID_FIELD_VALUE', 'CODE_HASH must be a 64-char lowercase sha256 hex string', { field }));
    }
}

// Applies one contiguous field-rule group while preserving finding order.
function validateCodePart(validator, action, field, value, allFields, errors) {
    // CODE_PART validation (one base64 slice of a chunked contract's source)
    if (field === 'CODE_PART') {
        let part = String(value);
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(part))
            errors.push(validator.buildError('INVALID_FIELD_VALUE', 'CODE_PART must be a valid base64 string', { field }));
        else if (Buffer.byteLength(part, 'utf8') > MAX_DEPLOYCHUNK_PART_BYTES)
            errors.push(validator.buildError('CODE_PART_TOO_LARGE', 'CODE_PART exceeds ' + MAX_DEPLOYCHUNK_PART_BYTES + ' byte limit', { field, limit: MAX_DEPLOYCHUNK_PART_BYTES }));
    }
}

// Applies one contiguous field-rule group while preserving finding order.
function validateChunkIndexes(validator, action, field, value, allFields, errors) {
    // CHUNK_INDEX / TOTAL_CHUNKS validation (non-negative integers; bounds checked cross-field)
    if (field === 'CHUNK_INDEX' || field === 'TOTAL_CHUNKS') {
        if (!validator.util.isNumeric(value) || !Number.isInteger(Number(value)) || Number(value) < 0)
            errors.push(validator.buildError('INVALID_FIELD_VALUE', field + ' must be a non-negative integer', { field, value }));
    }
}

// Applies one contiguous field-rule group while preserving finding order.
function validateParams(validator, action, field, value, allFields, errors) {
    // CONSTRUCTOR_PARAMS / PARAMS validation (array items must not contain separators)
    if (field === 'CONSTRUCTOR_PARAMS' || field === 'PARAMS') {
        if (Array.isArray(value)) {
            for (let i = 0; i < value.length; i++) {
                let param = String(value[i]);
                for (let ch of FORBIDDEN_TEXT_CHARS) {
                    if (param.includes(ch))
                        errors.push(validator.buildError('INVALID_PARAM_VALUE', field + '[' + i + '] cannot contain ' + (ch === '|' ? 'pipe (|)' : 'semicolon (;)'), { field, index: i, value: param }));
                }
            }
        }
    }
}

// Applies one contiguous field-rule group while preserving finding order.
function validateSigningKeys(validator, action, field, value, allFields, errors) {
    // SIGNING_PUBKEY / NEW_SIGNING_PUBKEY validation (64 hex chars, Ed25519)
    if (field === 'SIGNING_PUBKEY' || field === 'NEW_SIGNING_PUBKEY') {
        if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value))
            errors.push(validator.buildError('INVALID_FIELD_VALUE', field + ' must be a 64-character hex string (Ed25519 public key)', { field, value }));
    }
}

// Applies one contiguous field-rule group while preserving finding order.
function validateTargetContractIndex(validator, action, field, value, allFields, errors) {
    // TARGET_CONTRACT_INDEX validation (STAKE v3 / UNSTAKE v1 / DELEGATE v1): must be a positive integer
    if (field === 'TARGET_CONTRACT_INDEX') {
        if (!/^[0-9]+$/.test(String(value)) || Number(value) <= 0)
            errors.push(validator.buildError('INVALID_FIELD_VALUE', 'TARGET_CONTRACT_INDEX must be a positive integer', { field, value }));
    }
}

// Applies one contiguous field-rule group while preserving finding order.
function validateController(validator, action, field, value, allFields, errors) {
    // CONTROLLER validation (ISSUE v6 / ADDRESS v1, controller bind/unbind):
    // ACTION_INDEX of a deployed guard contract, so a non-negative integer.
    if (field === 'CONTROLLER') {
        if (!/^[0-9]+$/.test(String(value)))
            errors.push(validator.buildError('INVALID_FIELD_VALUE', 'CONTROLLER must be a non-negative integer (a contract ACTION_INDEX)', { field, value }));
    }
}

// Applies one contiguous field-rule group while preserving finding order.
function validateActionClass(validator, action, field, value, allFields, errors) {
    // ACTION_CLASS validation (ISSUE v6 / ADDRESS v1, programmable policy
    // layer): which native action class the guard gates. Must be one of the
    // indexer's CONTROLLER_ACTION_CLASSES (case-insensitive on the wire);
    // mirrored here as config['ACTION_CLASSES'].
    if (field === 'ACTION_CLASS') {
        let classes = validator.config['ACTION_CLASSES'] || [];
        if (classes.indexOf(String(value).toLowerCase()) === -1)
            errors.push(validator.buildError('INVALID_FIELD_VALUE', 'ACTION_CLASS must be one of: ' + classes.join(', '), { field, value, constraint: { valid: classes } }));
    }
}

// Applies one contiguous field-rule group while preserving finding order.
function validateUnbind(validator, action, field, value, allFields, errors) {
    // UNBIND validation (ISSUE v6 / ADDRESS v1): 0 = bind / 1 = unbind.
    if (field === 'UNBIND') {
        if (!validator.util.isValidLockValue(value))
            errors.push(validator.buildError('INVALID_FIELD_VALUE', 'UNBIND must be 0 (bind) or 1 (unbind)', { field, value, constraint: { valid: [0, 1] } }));
    }
}

// Applies one contiguous field-rule group while preserving finding order.
function validateCooldownBlocks(validator, action, field, value, allFields, errors) {
    // COOLDOWN_BLOCKS validation. Two callers with different ranges:
    //  - DEPLOY v1 (stakeable contract): integer in [1, 100000].
    //  - ISSUE v6 / ADDRESS v1 (controller bind): non-negative integer (>= 0),
    //    committed at bind as the friction on a later unbind (the indexer
    //    accepts /^\d+$/, so 0 is valid).
    if (field === 'COOLDOWN_BLOCKS') {
        if (value !== '' && value !== null && value !== undefined) {
            if (action === 'ISSUE' || action === 'ADDRESS') {
                if (!/^[0-9]+$/.test(String(value)))
                    errors.push(validator.buildError('INVALID_FIELD_VALUE', 'COOLDOWN_BLOCKS must be a non-negative integer', { field, value, constraint: { min: 0 } }));
            } else if (!validator.util.isNumeric(value)) {
                errors.push(validator.buildError('INVALID_FIELD_VALUE', 'COOLDOWN_BLOCKS must be numeric', { field, value }));
            } else {
                let cb = Number(value);
                if (cb < 1 || cb > 100000)
                    errors.push(validator.buildError('INVALID_FIELD_VALUE', 'COOLDOWN_BLOCKS must be in [1, 100000]', { field, value, constraint: { min: 1, max: 100000 } }));
            }
        }
    }
}

module.exports = { FIELD_VALIDATORS: [validateBlockFields, validateActionIndexFields, validateGasLimit, validateQuantity, validateVoteAmounts, validateCallbackContract, validateCallbackDelay, validateMethod, validateCodeEncoding, validateCodeHash, validateCodePart, validateChunkIndexes, validateParams, validateSigningKeys, validateTargetContractIndex, validateController, validateActionClass, validateUnbind, validateCooldownBlocks] };
