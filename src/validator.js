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
 * Per-action input validation rules for all 29 ACTION types
 *
 ********************************************************************/

const formats = require('./formats.js');
const config  = require('./config.js');
const { SDKValidationError, SDKContractError } = require('./errors.js');
const { ADDRESS_REF_FIELDS } = require('./addressRefFields.js');

// Flat set of address-bearing wire fields (excludes type-gated LIST.ITEM, validated
// per list TYPE elsewhere). A ^<id> reference to an already-indexed address is valid
// anywhere a full address is; the indexer resolves it via getAddressId and the SDK
// address compactor (addressResolver.js) emits this form.
const ADDRESS_REF_FIELD_SET = (() => {
    const s = new Set();
    for (const a of Object.keys(ADDRESS_REF_FIELDS))
        for (const spec of ADDRESS_REF_FIELDS[a])
            if (!spec.listType) s.add(spec.field);
    return s;
})();

// Maximum values
const MAX_SUPPLY_CEILING = 1000000000000000000000; // 1 sextillion
const MAX_DECIMALS       = 18;
const MAX_TICK_LENGTH    = 250;
const MAX_DESC_LENGTH    = 250;
const MAX_MESSAGE_LENGTH = 1048576; // 1MB
// 64KB contract source code limit. Must match the indexer (DEPLOY) and the VM
// isolate limit. Canonical source of truth: xchain-documentation/protocol/constants.js
// (MAX_CODE_SIZE); kept equal by the cross-service regression suite.
const MAX_CODE_SIZE      = 65536;

// Max base64 bytes per DEPLOY v4 carrier CODE_PART (chunked deploy). Canonical source:
// xchain-documentation/protocol/constants.js (MAX_DEPLOYCHUNK_PART_BYTES); kept
// equal to the indexer's per-chunk cap by the cross-service regression suite.
const MAX_DEPLOYCHUNK_PART_BYTES = 7800;
// Max chunks one DEPLOY may assemble (canonical: constants.js MAX_DEPLOY_CHUNKS).
const MAX_DEPLOY_CHUNKS = 16;

// Allowed TICK characters: a-zA-Z0-9 and ~!@#$%^&*()_+-={}[]:<>.?
// Must stay an exact match for the indexer's TICK_CHARACTERS (xchain-indexer
// src/config.js); the SDK must never be more permissive than consensus.
// Forbidden: \ | ; . / and ^ as first char
const TICK_REGEX = /^[a-zA-Z0-9~!@#$%^&*()_+\-={}[\]:<>.?]+$/;
const TICK_FORBIDDEN_FIRST_CHAR = '^';

// Characters forbidden in text fields (pipe = field separator, semicolon = command separator)
const FORBIDDEN_TEXT_CHARS = ['|', ';'];

// Valid FIAT currency codes. Must stay a byte-equal allow-list with the indexer's
// config['FIATS'] keys (xchain-indexer/src/config.js), which is the on-chain arbiter
// for PRICE FIAT_CODE. A subset here makes the SDK silently refuse a FIAT the protocol
// accepts (EUR/KRW were missing). The cross-service parity assertion in
// xchain-e2e-test/test/regression/protocol-size-limits.regression.js guards this.
const VALID_FIAT_CODES = ['USD', 'CAD', 'AUD', 'MXN', 'GBP', 'JPY', 'CNY', 'CHF', 'BRL', 'INR', 'EUR', 'KRW'];

// Valid coin identifiers (from the canonical coin registry).
const VALID_COINS = [...require('./coins').ALLOWED_COINS];

// Required fields per action (minimum fields that must be present regardless of version)
const ACTION_REQUIRED_FIELDS = {
    ADDRESS:            [],
    AIRDROP:            ['TICK', 'AMOUNT', 'LIST_ACTION_INDEX'],
    BATCH:              ['COMMAND'],
    BROADCAST:          [],
    CALLBACK:           ['TICK'],
    COINPAY:            ['ORDER_MATCH_ACTION_INDEX'],
    COLLECT:            [],
    DELEGATE:           [],
    // DEPLOY required fields are version-dependent (inline v0/v1 + assemble v2/v3 need
    // GAS_LIMIT; the v4 chunk carrier needs CODE_HASH/CHUNK_INDEX/TOTAL_CHUNKS/CODE_PART
    // but no GAS_LIMIT), so they are all enforced per-version in _validateDeploy.
    DEPLOY:             [],
    DEPOSIT:            ['CONTRACT_ACTION_INDEX', 'TICK', 'QUANTITY'],
    DESTROY:            ['TICK', 'AMOUNT'],
    DISPENSER:          [],
    DIVIDEND:           ['TICK', 'DIVIDEND_TICK', 'AMOUNT'],
    EXECUTE:            ['CONTRACT_ACTION_INDEX', 'METHOD'],
    FILE:               ['NAME', 'TYPE'],
    ISSUE:              ['TICK'],
    LINK:               ['COIN1', 'COIN1_ACTION_INDEX', 'COIN2', 'COIN2_ACTION_INDEX'],
    LIST:               ['ITEM'],
    MESSAGE:            ['COIN', 'DESTINATION'],
    MINT:               ['TICK', 'AMOUNT'],
    ORDER:              [],
    PRICE:              ['COIN', 'TICK', 'FIAT', 'VALUE'],
    SEND:               ['TICK', 'AMOUNT', 'DESTINATION'],
    SLEEP:              ['RESUME_BLOCK'],
    STAKE:              ['AMOUNT', 'SIGNING_PUBKEY'],
    SWAP:               [],
    SWEEP:              ['DESTINATION'],
    UNSTAKE:            ['SIGNING_PUBKEY'],
    WITHDRAW:           ['CONTRACT_ACTION_INDEX', 'TICK', 'QUANTITY']
};

// Actions that have cancel/close/edit sub-operations via ACTION_INDEX reference
// For these, the base required fields don't apply when an action index field is present
const ACTION_INDEX_FIELDS = {
    BROADCAST: 'BROADCAST_ACTION_INDEX',
    DISPENSER: 'DISPENSER_ACTION_INDEX',
    ORDER:     'ORDER_ACTION_INDEX',
    SWAP:      'SWAP_ACTION_INDEX'
};


class Validator {

    constructor(util) {
        this.util   = util;
        this.config = config.getConfig();
    }

    // Returns array of error objects. Empty array = valid.
    validate(action, fields) {
        let errors = [];

        // Guard against null/undefined fields
        if (!fields || typeof fields !== 'object') fields = {};

        // Check action exists. Use hasOwnProperty so a crafted action name that
        // matches an Object.prototype property (__proto__, constructor, toString,
        // hasOwnProperty, valueOf, ...) resolves to UNKNOWN_ACTION instead of the
        // truthy inherited value, which otherwise slipped past this guard and
        // then threw "required is not iterable" on the ACTION_REQUIRED_FIELDS
        // lookup below (prototype-pollution-shaped crash in the validation path).
        if (!Object.prototype.hasOwnProperty.call(formats, action)) {
            errors.push(this._error('UNKNOWN_ACTION', 'Unknown ACTION type: ' + action, { action }));
            return errors;
        }

        // Check required fields (skip if this is a cancel/edit operation via action index)
        let actionIndexField = ACTION_INDEX_FIELDS[action];
        let isIndexOperation = actionIndexField && !this._isEmpty(fields[actionIndexField]);

        if (!isIndexOperation) {
            let required = ACTION_REQUIRED_FIELDS[action] || [];
            for (let field of required) {
                if (this._isEmpty(fields[field])) {
                    errors.push(this._error('MISSING_REQUIRED_FIELD',
                        action + ' requires field: ' + field,
                        { action, field }));
                }
            }
        }

        for (let field in fields) {
            let value = fields[field];
            if (this._isEmpty(value)) continue;

            let fieldErrors = this._validateField(action, field, value, fields);
            errors.push(...fieldErrors);
        }

        let actionErrors = this._validateAction(action, fields);
        errors.push(...actionErrors);

        return errors;
    }

    _validateField(action, field, value, allFields) {
        let errors = [];

        // TICK validation
        if (field === 'TICK' || field === 'GIVE_TICK' || field === 'GET_TICK' ||
            field === 'DIVIDEND_TICK' || field === 'CALLBACK_TICK') {
            if (action === 'ISSUE' && field === 'TICK') {
                // Full TICK name validation on ISSUE (includes ^ first char check)
                errors.push(...this._validateTickName(value));
            } else if (String(value).startsWith('^')) {
                // TICK_ID reference (^123), only valid outside of ISSUE
                let id = String(value).substring(1);
                if (!this.util.isNumeric(id))
                    errors.push(this._error('INVALID_TICK_ID', field + ' ID reference must be numeric: ' + value, { field, value }));
            }
        }

        // MEMO validation
        if (field === 'MEMO') {
            errors.push(...this._validateTextContent(field, value));
        }

        // DESCRIPTION validation
        if (field === 'DESCRIPTION') {
            errors.push(...this._validateTextContent(field, value));
            if (String(value).length > MAX_DESC_LENGTH)
                errors.push(this._error('INVALID_FIELD_VALUE', 'DESCRIPTION must be ' + MAX_DESC_LENGTH + ' characters or less', { field, value: String(value).length, constraint: { max: MAX_DESC_LENGTH } }));
        }

        // DECIMALS validation
        if (field === 'DECIMALS') {
            if (!Number.isInteger(Number(value)) || Number(value) < 0 || Number(value) > MAX_DECIMALS)
                errors.push(this._error('INVALID_FIELD_VALUE', 'DECIMALS must be an integer between 0 and ' + MAX_DECIMALS, { field, value, constraint: { min: 0, max: MAX_DECIMALS, type: 'integer' } }));
        }

        // MAX_SUPPLY validation (use BigInt to avoid precision loss with large numbers)
        if (field === 'MAX_SUPPLY') {
            try {
                let bigVal = BigInt(String(value).split('.')[0]);
                if (bigVal < 0n || bigVal > BigInt('1000000000000000000000'))
                    errors.push(this._error('INVALID_FIELD_VALUE', 'MAX_SUPPLY must be between 0 and ' + MAX_SUPPLY_CEILING, { field, value, constraint: { min: 0, max: MAX_SUPPLY_CEILING } }));
            } catch (e) {
                errors.push(this._error('INVALID_FIELD_VALUE', 'MAX_SUPPLY must be numeric', { field, value }));
            }
        }

        // Lock field validation
        if (this.config['LOCK_FIELDS'].includes(field)) {
            if (!this.util.isValidLockValue(value))
                errors.push(this._error('INVALID_FIELD_VALUE', field + ' must be 0 or 1', { field, value, constraint: { valid: [0, 1] } }));
        }
        // NOTE: ISSUE v6 / ADDRESS v1 controller field checks (CONTROLLER / ACTION_CLASS /
        // UNBIND / COOLDOWN_BLOCKS) live in the consolidated block further down (~line 419).

        // FIAT_CODE validation
        if (field === 'FIAT_CODE') {
            if (!VALID_FIAT_CODES.includes(String(value).toUpperCase()))
                errors.push(this._error('INVALID_FIELD_VALUE', 'FIAT_CODE must be one of: ' + VALID_FIAT_CODES.join(', '), { field, value, constraint: { valid: VALID_FIAT_CODES } }));
        }

        // FIAT_AMOUNT format validation (X.XX)
        if (field === 'FIAT_AMOUNT') {
            if (!this.util.isNumeric(value) || !/^\d+\.\d{2}$/.test(String(value)))
                errors.push(this._error('INVALID_FIELD_VALUE', 'FIAT_AMOUNT must be in X.XX format', { field, value }));
        }

        // COIN field validation
        if (field === 'COIN' || field === 'GIVE_COIN' || field === 'GET_COIN' || field === 'COIN1' || field === 'COIN2') {
            if (!VALID_COINS.includes(String(value).toUpperCase()))
                errors.push(this._error('INVALID_FIELD_VALUE', field + ' must be one of: ' + VALID_COINS.join(', '), { field, value, constraint: { valid: VALID_COINS } }));
        }

        // ADDRESS_ID reference (^57): valid for any address-bearing field, only
        // outside the full-address form. Mirrors the TICK ^id branch above; the
        // indexer resolves ^<id> via getAddressId, and addressResolver.js emits it.
        if (ADDRESS_REF_FIELD_SET.has(field) && String(value).charAt(0) === '^') {
            let id = String(value).substring(1);
            if (!this.util.isNumeric(id))
                errors.push(this._error('INVALID_ADDRESS_ID', field + ' ID reference must be numeric: ' + value, { field, value }));
        }

        // DESTINATION / GET_ADDRESS / TRANSFER full-address validation. A ^<id>
        // reference is handled by the branch above, so skip the crypto-address check
        // for it (an empty value never reaches here; the caller skips empties).
        if (field === 'DESTINATION' || field === 'GET_ADDRESS' || field === 'TRANSFER') {
            if (String(value).charAt(0) !== '^' && !this.util.isCryptoAddress(value))
                errors.push(this._error('INVALID_FIELD_VALUE', field + ' must be a valid crypto address', { field, value }));
        }

        // ENCRYPTION_METHOD validation (numeric in all contexts)
        // - MESSAGE: 1=ECIES, 2=ECDH, 3=AES (symmetric-with-pre-shared-key)
        // - FILE v1 (gated): 1=AES-256-GCM. Other values reserved for future v1 algorithms.
        if (field === 'ENCRYPTION_METHOD') {
            if (action === 'FILE') {
                if (!this.util.isValidValue(value, [1]))
                    errors.push(this._error('INVALID_FIELD_VALUE',
                        'FILE ENCRYPTION_METHOD must be 1 (AES-256-GCM)',
                        { field, value, constraint: { valid: [1] } }));
            } else if (!this.util.isValidValue(value, [1, 2, 3])) {
                errors.push(this._error('INVALID_FIELD_VALUE', 'ENCRYPTION_METHOD must be 1 (ECIES), 2 (ECDH), or 3 (AES)', { field, value, constraint: { valid: [1, 2, 3] } }));
            }
        }

        // FILE v1 gated-content fields
        if (action === 'FILE' && field === 'KEY_HASH') {
            if (value !== '' && !/^[0-9a-f]{64}$/i.test(String(value)))
                errors.push(this._error('INVALID_FIELD_VALUE',
                    'KEY_HASH must be a 64-character lowercase hex string (sha256(K))',
                    { field, value }));
        }
        if (action === 'FILE' && field === 'GATE_TICKER') {
            // Empty is allowed (= public file); when set, basic TICK constraints apply.
            if (value !== '' && /[|;./]/.test(String(value)))
                errors.push(this._error('INVALID_FIELD_VALUE',
                    'GATE_TICKER cannot contain |, ;, ., or /',
                    { field, value }));
        }

        // MESSAGE content length validation
        if (field === 'PLAINTEXT_MESSAGE' || field === 'ENCRYPTED_MESSAGE' || field === 'ENCRYPTION_KEY') {
            if (String(value).length > MAX_MESSAGE_LENGTH)
                errors.push(this._error('INVALID_FIELD_VALUE', field + ' must be ' + MAX_MESSAGE_LENGTH + ' characters or less', { field, value: String(value).length, constraint: { max: MAX_MESSAGE_LENGTH } }));
            errors.push(...this._validateTextContent(field, value));
        }

        // FEE_PREFERENCE validation (ADDRESS action)
        if (field === 'FEE_PREFERENCE') {
            if (!this.util.isValidValue(value, [1, 2, 3]))
                errors.push(this._error('INVALID_FIELD_VALUE', 'FEE_PREFERENCE must be 1 (destroy), 2 (protocol), or 3 (community)', { field, value, constraint: { valid: [1, 2, 3] } }));
        }

        // DISPENSER_PREFERENCE validation (ADDRESS action): who may open dispensers on this address
        if (field === 'DISPENSER_PREFERENCE') {
            if (!this.util.isValidValue(value, [1, 2]))
                errors.push(this._error('INVALID_FIELD_VALUE', 'DISPENSER_PREFERENCE must be 1 (owner only) or 2 (anyone)', { field, value, constraint: { valid: [1, 2] } }));
        }

        // LIST TYPE validation
        if (field === 'TYPE' && action === 'LIST') {
            if (!this.util.isValidValue(value, [1, 2]))
                errors.push(this._error('INVALID_FIELD_VALUE', 'LIST TYPE must be 1 (TICK list) or 2 (ADDRESS list)', { field, value, constraint: { valid: [1, 2] } }));
        }

        // LIST EDIT validation
        if (field === 'EDIT') {
            if (!this.util.isValidValue(value, [1, 2]))
                errors.push(this._error('INVALID_FIELD_VALUE', 'EDIT must be 1 (ADD) or 2 (REMOVE)', { field, value, constraint: { valid: [1, 2] } }));
        }

        // Binary 0/1 flag fields
        // - SWEEP:               BALANCES / OWNERSHIPS / ORDERS / SWAPS / DISPENSERS
        // - ORDER / SWAP / DISPENSER: GIVE_OWNERSHIP / GET_OWNERSHIP
        if (field === 'BALANCES' || field === 'OWNERSHIPS' ||
            field === 'ORDERS'   || field === 'SWAPS'      || field === 'DISPENSERS' ||
            field === 'GIVE_OWNERSHIP' || field === 'GET_OWNERSHIP') {
            if (!this.util.isValidLockValue(value))
                errors.push(this._error('INVALID_FIELD_VALUE', field + ' must be 0 or 1', { field, value, constraint: { valid: [0, 1] } }));
        }

        // AMOUNT validation: all listed fields must be numeric.
        if (field === 'AMOUNT' || field === 'GIVE_AMOUNT' || field === 'GET_AMOUNT' ||
            field === 'GIVE_ESCROW' || field === 'CALLBACK_AMOUNT' || field === 'TRANSFER_SUPPLY' ||
            field === 'MINT_SUPPLY' || field === 'MAX_MINT' || field === 'MINT_ADDRESS_MAX') {
            if (!this.util.isNumeric(value))
                errors.push(this._error('INVALID_FIELD_VALUE', field + ' must be numeric', { field, value }));
        }

        // Spend/transfer amounts must additionally be positive: zero or negative
        // produces a transaction the indexer rejects (e.g. STAKE/SEND require >0),
        // so fail client-side rather than emit a doomed action. The supply-cap
        // fields above legitimately accept 0 (disabled) and so are excluded here.
        if (field === 'AMOUNT' || field === 'GIVE_AMOUNT' || field === 'GET_AMOUNT' ||
            field === 'GIVE_ESCROW' || field === 'CALLBACK_AMOUNT') {
            if (this.util.isNumeric(value) && Number(value) <= 0)
                errors.push(this._error('INVALID_FIELD_VALUE', field + ' must be a positive number', { field, value }));
        }

        // FEE validation (BROADCAST, percentage format)
        if (field === 'FEE' && action === 'BROADCAST') {
            if (!this.util.isNumeric(value))
                errors.push(this._error('INVALID_FIELD_VALUE', 'FEE must be numeric (percentage)', { field, value }));
        }

        // Block number validation
        if (field === 'RESUME_BLOCK' || field === 'CALLBACK_BLOCK' ||
            field === 'MINT_START_BLOCK' || field === 'MINT_STOP_BLOCK') {
            if (!this.util.isNumeric(value))
                errors.push(this._error('INVALID_FIELD_VALUE', field + ' must be numeric', { field, value }));
        }

        // ACTION_INDEX fields must be numeric
        if (field === 'BROADCAST_ACTION_INDEX' || field === 'DISPENSER_ACTION_INDEX' ||
            field === 'ORDER_ACTION_INDEX' || field === 'SWAP_ACTION_INDEX' ||
            field === 'LIST_ACTION_INDEX' || field === 'COIN1_ACTION_INDEX' ||
            field === 'COIN2_ACTION_INDEX' || field === 'CONTRACT_ACTION_INDEX') {
            if (!this.util.isNumeric(value))
                errors.push(this._error('INVALID_FIELD_VALUE', field + ' must be numeric', { field, value }));
        }

        // GAS_LIMIT validation (must be positive integer)
        if (field === 'GAS_LIMIT') {
            if (!this.util.isNumeric(value) || Number(value) <= 0 || !Number.isInteger(Number(value)))
                errors.push(this._error('INVALID_FIELD_VALUE', 'GAS_LIMIT must be a positive integer', { field, value }));
        }

        // QUANTITY validation (must be numeric and positive)
        if (field === 'QUANTITY') {
            if (!this.util.isNumeric(value) || Number(value) <= 0)
                errors.push(this._error('INVALID_FIELD_VALUE', 'QUANTITY must be a positive number', { field, value }));
        }

        // METHOD validation (non-empty, no forbidden chars)
        if (field === 'METHOD') {
            if (typeof value !== 'string' || value.length === 0)
                errors.push(this._error('INVALID_FIELD_VALUE', 'METHOD must be a non-empty string', { field, value }));
            else
                errors.push(...this._validateTextContent(field, value));
        }

        // CODE_ENCODING validation (base64 string, decoded-size limit)
        if (field === 'CODE_ENCODING') {
            let b64 = String(value);
            if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
                errors.push(this._error('INVALID_FIELD_VALUE', 'CODE_ENCODING must be a valid base64 string', { field }));
            } else {
                let bytes = Buffer.from(b64, 'base64').length; // decoded source size
                if (bytes > MAX_CODE_SIZE)
                    errors.push(this._error('CODE_TOO_LARGE', 'Contract code exceeds ' + MAX_CODE_SIZE + ' byte limit (' + bytes + ' bytes)', { field, bytes, limit: MAX_CODE_SIZE }));
            }
        }

        // CODE_HASH validation: DEPLOY v2/v3 assemble + v4 carrier group key (sha256 hex)
        if (field === 'CODE_HASH') {
            if (!/^[0-9a-f]{64}$/.test(String(value)))
                errors.push(this._error('INVALID_FIELD_VALUE', 'CODE_HASH must be a 64-char lowercase sha256 hex string', { field }));
        }

        // CODE_PART validation (one base64 slice of a chunked contract's source)
        if (field === 'CODE_PART') {
            let part = String(value);
            if (!/^[A-Za-z0-9+/]*={0,2}$/.test(part))
                errors.push(this._error('INVALID_FIELD_VALUE', 'CODE_PART must be a valid base64 string', { field }));
            else if (Buffer.byteLength(part, 'utf8') > MAX_DEPLOYCHUNK_PART_BYTES)
                errors.push(this._error('CODE_PART_TOO_LARGE', 'CODE_PART exceeds ' + MAX_DEPLOYCHUNK_PART_BYTES + ' byte limit', { field, limit: MAX_DEPLOYCHUNK_PART_BYTES }));
        }

        // CHUNK_INDEX / TOTAL_CHUNKS validation (non-negative integers; bounds checked cross-field)
        if (field === 'CHUNK_INDEX' || field === 'TOTAL_CHUNKS') {
            if (!this.util.isNumeric(value) || !Number.isInteger(Number(value)) || Number(value) < 0)
                errors.push(this._error('INVALID_FIELD_VALUE', field + ' must be a non-negative integer', { field, value }));
        }

        // CONSTRUCTOR_PARAMS / PARAMS validation (array items must not contain separators)
        if (field === 'CONSTRUCTOR_PARAMS' || field === 'PARAMS') {
            if (Array.isArray(value)) {
                for (let i = 0; i < value.length; i++) {
                    let param = String(value[i]);
                    for (let ch of FORBIDDEN_TEXT_CHARS) {
                        if (param.includes(ch))
                            errors.push(this._error('INVALID_PARAM_VALUE', field + '[' + i + '] cannot contain ' + (ch === '|' ? 'pipe (|)' : 'semicolon (;)'), { field, index: i, value: param }));
                    }
                }
            }
        }

        // SIGNING_PUBKEY / NEW_SIGNING_PUBKEY validation (64 hex chars, Ed25519)
        if (field === 'SIGNING_PUBKEY' || field === 'NEW_SIGNING_PUBKEY') {
            if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value))
                errors.push(this._error('INVALID_FIELD_VALUE', field + ' must be a 64-character hex string (Ed25519 public key)', { field, value }));
        }

        // TARGET_CONTRACT_INDEX validation (STAKE v3 / UNSTAKE v1 / DELEGATE v1): must be a positive integer
        if (field === 'TARGET_CONTRACT_INDEX') {
            if (!/^[0-9]+$/.test(String(value)) || Number(value) <= 0)
                errors.push(this._error('INVALID_FIELD_VALUE', 'TARGET_CONTRACT_INDEX must be a positive integer', { field, value }));
        }

        // CONTROLLER validation (ISSUE v6 / ADDRESS v1, controller bind/unbind):
        // ACTION_INDEX of a deployed guard contract, so a non-negative integer.
        if (field === 'CONTROLLER') {
            if (!/^[0-9]+$/.test(String(value)))
                errors.push(this._error('INVALID_FIELD_VALUE', 'CONTROLLER must be a non-negative integer (a contract ACTION_INDEX)', { field, value }));
        }

        // ACTION_CLASS validation (ISSUE v6 / ADDRESS v1, programmable policy
        // layer): which native action class the guard gates. Must be one of the
        // indexer's CONTROLLER_ACTION_CLASSES (case-insensitive on the wire);
        // mirrored here as config['ACTION_CLASSES'].
        if (field === 'ACTION_CLASS') {
            let classes = this.config['ACTION_CLASSES'] || [];
            if (classes.indexOf(String(value).toLowerCase()) === -1)
                errors.push(this._error('INVALID_FIELD_VALUE', 'ACTION_CLASS must be one of: ' + classes.join(', '), { field, value, constraint: { valid: classes } }));
        }

        // UNBIND validation (ISSUE v6 / ADDRESS v1): 0 = bind / 1 = unbind.
        if (field === 'UNBIND') {
            if (!this.util.isValidLockValue(value))
                errors.push(this._error('INVALID_FIELD_VALUE', 'UNBIND must be 0 (bind) or 1 (unbind)', { field, value, constraint: { valid: [0, 1] } }));
        }

        // COOLDOWN_BLOCKS validation. Two callers with different ranges:
        //  - DEPLOY v1 (stakeable contract): integer in [1, 100000].
        //  - ISSUE v6 / ADDRESS v1 (controller bind): non-negative integer (>= 0),
        //    committed at bind as the friction on a later unbind (the indexer
        //    accepts /^\d+$/, so 0 is valid).
        if (field === 'COOLDOWN_BLOCKS') {
            if (value !== '' && value !== null && value !== undefined) {
                if (action === 'ISSUE' || action === 'ADDRESS') {
                    if (!/^[0-9]+$/.test(String(value)))
                        errors.push(this._error('INVALID_FIELD_VALUE', 'COOLDOWN_BLOCKS must be a non-negative integer', { field, value, constraint: { min: 0 } }));
                } else if (!this.util.isNumeric(value)) {
                    errors.push(this._error('INVALID_FIELD_VALUE', 'COOLDOWN_BLOCKS must be numeric', { field, value }));
                } else {
                    let cb = Number(value);
                    if (cb < 1 || cb > 100000)
                        errors.push(this._error('INVALID_FIELD_VALUE', 'COOLDOWN_BLOCKS must be in [1, 100000]', { field, value, constraint: { min: 1, max: 100000 } }));
                }
            }
        }

        // VALUE validation (BROADCAST)
        if (field === 'VALUE') {
            if (!this.util.isNumeric(value))
                errors.push(this._error('INVALID_FIELD_VALUE', 'VALUE must be numeric', { field, value }));
        }

        // MESSAGE field validation (BROADCAST)
        if (field === 'MESSAGE' && action === 'BROADCAST') {
            errors.push(...this._validateTextContent(field, value));
        }

        return errors;
    }

    _validateAction(action, fields) {
        let errors = [];

        switch (action) {
            case 'ADDRESS':
            case 'ISSUE':
                // ISSUE v6 / ADDRESS v1 controller bind/unbind cross-field rules (no-op for a
                // plain ISSUE/ADDRESS that carries no controller fields).
                errors.push(...this._validateControllerBind(fields));
                break;
            case 'BATCH':
                errors.push(...this._validateBatch(fields));
                break;
            case 'BROADCAST':
                errors.push(...this._validateBroadcast(fields));
                break;
            case 'DEPLOY':
                errors.push(...this._validateDeploy(fields));
                break;
            case 'DISPENSER':
                errors.push(...this._validateDispenser(fields));
                break;
            case 'LIST':
                errors.push(...this._validateList(fields));
                break;
            case 'ORDER':
                errors.push(...this._validateOrder(fields));
                break;
            case 'SWAP':
                errors.push(...this._validateSwap(fields));
                break;
        }

        return errors;
    }

    // Controller bind/unbind cross-field rules (ISSUE v6 token controller / ADDRESS v1 account
    // controller). Only applies when controller fields are present; a plain ISSUE/ADDRESS is
    // unaffected. Stateless client-side pre-check only (the indexer owns "already bound", contract
    // existence, etc.). UNBIND=1 drops a binding (CONTROLLER then ignored); a bind requires CONTROLLER.
    _validateControllerBind(fields) {
        let errors = [];
        let hasController = !this.util.isNull(fields['CONTROLLER']);
        let hasClass      = !this.util.isNull(fields['ACTION_CLASS']);
        let hasUnbind     = !this.util.isNull(fields['UNBIND']);
        // Not a controller bind at all - nothing to check.
        if (!hasController && !hasClass && !hasUnbind)
            return errors;
        let isUnbind = Number(fields['UNBIND']) === 1;
        if (!hasClass)
            errors.push(this._error('MISSING_REQUIRED_FIELD', 'ACTION_CLASS is required for a controller bind/unbind', { field: 'ACTION_CLASS' }));
        if (!isUnbind && !hasController)
            errors.push(this._error('MISSING_REQUIRED_FIELD', 'CONTROLLER is required to bind a controller', { field: 'CONTROLLER' }));
        return errors;
    }

    // BATCH-specific validation
    _validateBatch(fields) {
        let errors = [];
        if (this._isEmpty(fields.COMMAND)) return errors;

        let commands = String(fields.COMMAND).split(';');
        let mintCount = 0;
        let issueCount = 0;
        let fileCount = 0;

        for (let cmd of commands) {
            let parts = cmd.split('|');
            let cmdAction = parts[0];

            if (cmdAction === 'BATCH')
                errors.push(this._error('BATCH_CONSTRAINT', 'BATCH cannot contain nested BATCH actions'));
            if (cmdAction === 'DEPLOY')
                errors.push(this._error('BATCH_CONSTRAINT', 'BATCH cannot contain DEPLOY actions'));
            if (cmdAction === 'MINT') mintCount++;
            if (cmdAction === 'ISSUE') issueCount++;
            if (cmdAction === 'FILE') fileCount++;
        }

        if (mintCount > 1)
            errors.push(this._error('BATCH_CONSTRAINT', 'BATCH can contain at most 1 MINT action', { count: mintCount }));
        if (issueCount > 1)
            errors.push(this._error('BATCH_CONSTRAINT', 'BATCH can contain at most 1 ISSUE action', { count: issueCount }));
        if (fileCount > 1)
            errors.push(this._error('BATCH_CONSTRAINT', 'BATCH can contain at most 1 FILE action (one rawData per transaction)', { count: fileCount }));

        return errors;
    }

    // BROADCAST-specific validation
    _validateBroadcast(fields) {
        let errors = [];
        // Must have either MESSAGE or BROADCAST_ACTION_INDEX
        if (this._isEmpty(fields.MESSAGE) && this._isEmpty(fields.BROADCAST_ACTION_INDEX))
            errors.push(this._error('MISSING_REQUIRED_FIELD', 'BROADCAST requires MESSAGE or BROADCAST_ACTION_INDEX'));
        return errors;
    }

    // DEPLOY-specific validation (version-dependent)
    _validateDeploy(fields) {
        // v4 = chunk carrier: validate the slice fields only; no GAS_LIMIT / inline code / staking.
        if (Number(fields.VERSION) === 4)
            return this._validateDeployCarrier(fields);

        let errors = [];
        // GAS_LIMIT is required for an actual deploy (inline v0/v1 + chunked-assemble v2/v3).
        if (this._isEmpty(fields.GAS_LIMIT))
            errors.push(this._error('MISSING_REQUIRED_FIELD', 'DEPLOY requires GAS_LIMIT', { field: 'GAS_LIMIT' }));
        // Inline (v0/v1) carries CODE_ENCODING; chunked-assemble (v2/v3) carries CODE_HASH and
        // assembles the code from prior v4 carriers. Exactly one must be present.
        let hasInline = !this._isEmpty(fields.CODE_ENCODING);
        let hasHash   = !this._isEmpty(fields.CODE_HASH);
        if (!hasInline && !hasHash)
            errors.push(this._error('MISSING_REQUIRED_FIELD', 'DEPLOY requires CODE_ENCODING (inline) or CODE_HASH (chunked)', { action: 'DEPLOY' }));
        else if (hasInline && hasHash)
            errors.push(this._error('DEPLOY_CONSTRAINT', 'DEPLOY cannot carry both CODE_ENCODING and CODE_HASH', { action: 'DEPLOY' }));
        // v1 stakeable-contract config: SLASH_DESTINATION without COOLDOWN_BLOCKS is meaningless.
        // (The indexer applies the same rule and additionally defaults SLASH_DESTINATION->BURN
        // when COOLDOWN_BLOCKS is set without a destination, so we don't enforce SLASH_DESTINATION
        // as required when COOLDOWN_BLOCKS is present.)
        let hasCooldown = !this._isEmpty(fields.COOLDOWN_BLOCKS);
        let hasDest     = !this._isEmpty(fields.SLASH_DESTINATION);
        if (hasDest && !hasCooldown)
            errors.push(this._error('DEPLOY_CONSTRAINT', 'SLASH_DESTINATION requires COOLDOWN_BLOCKS', { cooldown: fields.COOLDOWN_BLOCKS, destination: fields.SLASH_DESTINATION }));
        return errors;
    }

    // DEPLOY v4 (chunk carrier) validation: required slice fields + CHUNK_INDEX < TOTAL_CHUNKS <= MAX_DEPLOY_CHUNKS.
    // (Field-level format checks for CODE_HASH/CODE_PART/CHUNK_INDEX/TOTAL_CHUNKS run in the
    // per-field pass.)
    _validateDeployCarrier(fields) {
        let errors = [];
        for (let f of ['CODE_HASH', 'CHUNK_INDEX', 'TOTAL_CHUNKS', 'CODE_PART'])
            if (this._isEmpty(fields[f]))
                errors.push(this._error('MISSING_REQUIRED_FIELD', 'DEPLOY v4 (chunk carrier) requires ' + f, { field: f }));
        let total = Number(fields.TOTAL_CHUNKS);
        let idx   = Number(fields.CHUNK_INDEX);
        if (!this._isEmpty(fields.TOTAL_CHUNKS) && (total < 1 || total > MAX_DEPLOY_CHUNKS))
            errors.push(this._error('DEPLOY_CHUNK_CONSTRAINT', 'TOTAL_CHUNKS must be in [1, ' + MAX_DEPLOY_CHUNKS + ']', { total }));
        if (!this._isEmpty(fields.CHUNK_INDEX) && !this._isEmpty(fields.TOTAL_CHUNKS) && idx >= total)
            errors.push(this._error('DEPLOY_CHUNK_CONSTRAINT', 'CHUNK_INDEX must be < TOTAL_CHUNKS', { index: idx, total }));
        return errors;
    }

    // DISPENSER-specific validation
    _validateDispenser(fields) {
        let errors = [];
        // If not a cancel/edit (no DISPENSER_ACTION_INDEX), full create requires
        // give-side fields + GET_AMOUNT, plus either GET_TICK (token-paid) or
        // GET_COIN (coin-paid; the primary §40.7.1 lane where a buyer pays in
        // the native coin; GET_TICK is empty in that mode per DISPENSER.md).
        // Ownership dispensers (GIVE_OWNERSHIP=1) are single-shot: GIVE_AMOUNT
        // and GIVE_ESCROW must be EMPTY in that mode, and GET_AMOUNT is the price.
        if (this._isEmpty(fields.DISPENSER_ACTION_INDEX)) {
            let isOwnershipGive = (Number(fields.GIVE_OWNERSHIP || 0) === 1);
            let required = ['GIVE_TICK', 'GET_AMOUNT'];
            if (!isOwnershipGive) required.push('GIVE_AMOUNT');
            for (let field of required) {
                if (this._isEmpty(fields[field]))
                    errors.push(this._error('MISSING_REQUIRED_FIELD', 'DISPENSER create requires field: ' + field, { field }));
            }
            if (isOwnershipGive) {
                if (!this._isEmpty(fields.GIVE_AMOUNT))
                    errors.push(this._error('INVALID_FIELD_VALUE', 'GIVE_AMOUNT must be empty when GIVE_OWNERSHIP=1', { field: 'GIVE_AMOUNT' }));
                if (!this._isEmpty(fields.GIVE_ESCROW))
                    errors.push(this._error('INVALID_FIELD_VALUE', 'GIVE_ESCROW must be empty when GIVE_OWNERSHIP=1', { field: 'GIVE_ESCROW' }));
            }
            if (this._isEmpty(fields.GET_TICK) && this._isEmpty(fields.GET_COIN))
                errors.push(this._error('MISSING_REQUIRED_FIELD',
                    'DISPENSER create requires GET_TICK (token-paid) or GET_COIN (coin-paid)',
                    { field: 'GET_COIN' }));
        }
        return errors;
    }

    // ORDER-specific validation
    _validateOrder(fields) {
        let errors = [];
        if (this._isEmpty(fields.ORDER_ACTION_INDEX)) {
            // At least one side must have a TICK (can't trade coin for coin)
            if (this._isEmpty(fields.GIVE_TICK) && this._isEmpty(fields.GET_TICK))
                errors.push(this._error('MISSING_REQUIRED_FIELD', 'ORDER create requires at least one of GIVE_TICK or GET_TICK'));
            // Amounts required unless the corresponding side is an ownership offer/bid
            let isOwnershipGive = (Number(fields.GIVE_OWNERSHIP || 0) === 1);
            let isOwnershipGet  = (Number(fields.GET_OWNERSHIP  || 0) === 1);
            if (!isOwnershipGive && this._isEmpty(fields.GIVE_AMOUNT))
                errors.push(this._error('MISSING_REQUIRED_FIELD', 'ORDER create requires field: GIVE_AMOUNT', { field: 'GIVE_AMOUNT' }));
            if (!isOwnershipGet  && this._isEmpty(fields.GET_AMOUNT))
                errors.push(this._error('MISSING_REQUIRED_FIELD', 'ORDER create requires field: GET_AMOUNT', { field: 'GET_AMOUNT' }));
            if (isOwnershipGive && !this._isEmpty(fields.GIVE_AMOUNT))
                errors.push(this._error('INVALID_FIELD_VALUE', 'GIVE_AMOUNT must be empty when GIVE_OWNERSHIP=1', { field: 'GIVE_AMOUNT' }));
            if (isOwnershipGet  && !this._isEmpty(fields.GET_AMOUNT))
                errors.push(this._error('INVALID_FIELD_VALUE', 'GET_AMOUNT must be empty when GET_OWNERSHIP=1', { field: 'GET_AMOUNT' }));
            if (isOwnershipGive && this._isEmpty(fields.GIVE_TICK))
                errors.push(this._error('MISSING_REQUIRED_FIELD', 'ORDER with GIVE_OWNERSHIP=1 requires GIVE_TICK', { field: 'GIVE_TICK' }));
            if (isOwnershipGet  && this._isEmpty(fields.GET_TICK))
                errors.push(this._error('MISSING_REQUIRED_FIELD', 'ORDER with GET_OWNERSHIP=1 requires GET_TICK', { field: 'GET_TICK' }));
        }
        return errors;
    }

    // SWAP-specific validation
    _validateSwap(fields) {
        let errors = [];
        if (this._isEmpty(fields.SWAP_ACTION_INDEX)) {
            let isOwnershipGive = (Number(fields.GIVE_OWNERSHIP || 0) === 1);
            let isOwnershipGet  = (Number(fields.GET_OWNERSHIP  || 0) === 1);
            let required = ['GIVE_TICK', 'GET_TICK'];
            if (!isOwnershipGive) required.push('GIVE_AMOUNT');
            if (!isOwnershipGet)  required.push('GET_AMOUNT');
            for (let field of required) {
                if (this._isEmpty(fields[field]))
                    errors.push(this._error('MISSING_REQUIRED_FIELD', 'SWAP create requires field: ' + field, { field }));
            }
            if (isOwnershipGive && !this._isEmpty(fields.GIVE_AMOUNT))
                errors.push(this._error('INVALID_FIELD_VALUE', 'GIVE_AMOUNT must be empty when GIVE_OWNERSHIP=1', { field: 'GIVE_AMOUNT' }));
            if (isOwnershipGet  && !this._isEmpty(fields.GET_AMOUNT))
                errors.push(this._error('INVALID_FIELD_VALUE', 'GET_AMOUNT must be empty when GET_OWNERSHIP=1', { field: 'GET_AMOUNT' }));
        }
        return errors;
    }

    // LIST-specific validation
    _validateList(fields) {
        let errors = [];
        // LIST v0 (create) requires TYPE; LIST v1 (edit) requires EDIT + LIST_ACTION_INDEX
        if (this._isEmpty(fields.LIST_ACTION_INDEX) && this._isEmpty(fields.EDIT)) {
            // Create mode: TYPE is required
            if (this._isEmpty(fields.TYPE))
                errors.push(this._error('MISSING_REQUIRED_FIELD', 'LIST create requires field: TYPE', { field: 'TYPE' }));
        }
        return errors;
    }

    _validateTickName(value) {
        let errors = [];
        let name = String(value);

        if (name.length === 0 || name.length > MAX_TICK_LENGTH)
            errors.push(this._error('INVALID_TICK_NAME', 'TICK name must be 1-' + MAX_TICK_LENGTH + ' characters', { value, length: name.length }));

        if (name.startsWith(TICK_FORBIDDEN_FIRST_CHAR))
            errors.push(this._error('INVALID_TICK_NAME', 'TICK name cannot start with ^', { value }));

        if (!TICK_REGEX.test(name))
            errors.push(this._error('INVALID_TICK_NAME', 'TICK name contains invalid characters', { value, allowed: 'a-zA-Z0-9~!@#$%^&*()_+-={}[]:<>.?' }));

        // Check for forbidden characters
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
    }

    _validateTextContent(field, value) {
        let errors = [];
        let text = String(value);
        for (let ch of FORBIDDEN_TEXT_CHARS) {
            if (text.includes(ch))
                errors.push(this._error('FORBIDDEN_CHARACTER', field + ' cannot contain ' + (ch === '|' ? 'pipe (|)' : 'semicolon (;)'), { field, value }));
        }
        return errors;
    }

    _isEmpty(value) {
        return value === null || value === undefined || value === '';
    }

    _error(code, message, details = {}) {
        return { code, message, details };
    }

    validateOrThrow(action, fields) {
        let errors = this.validate(action, fields);
        if (errors.length > 0) {
            throw new SDKValidationError(
                errors[0].code,
                errors.length === 1
                    ? errors[0].message
                    : errors.length + ' validation errors: ' + errors.map(e => e.message).join('; '),
                { action, errors }
            );
        }
    }

}

module.exports = Validator;
// Exported for the cross-service regression suite, which asserts this equals the
// canonical protocol MAX_CODE_SIZE shared by the indexer and the VM.
module.exports.MAX_CODE_SIZE = MAX_CODE_SIZE;

// Exported for the cross-service FIAT-allow-list parity test (must equal the
// canonical protocol.VALID_FIAT_CODES, which mirrors the indexer arbiter).
module.exports.VALID_FIAT_CODES = VALID_FIAT_CODES;
