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
 * Cross-field rules the indexer enforces with nothing but the wire fields (and,
 * for XBRIDGE, the chain the validator was built for): the FILE threshold/gate
 * pairing, the DISPENSER fiat pairing, the VOTE v0 poll rules, the ISSUE supply
 * and mint-window orderings and the XBRIDGE chain and tick-shape rules.
 * Installed onto Validator.prototype, so `this` is the validator.
 *
 ********************************************************************/

'use strict';

const FormatSelector = require('../format_selector.js');
const { MAX_MESSAGE_LENGTH, MAX_CALLBACK_METHOD_LENGTH, MAX_TICK_LENGTH } = require('./field_limits.js');
const { networkPlane } = require('./consensus_field_rules.js');

const TALLY_MODES  = ['approval', 'split'];
const WEIGHT_MODES = ['balance', 'flat', 'quadratic', 'time_weighted'];

// The indexer trims every wire field before it reads one, so a value's verdict is
// the verdict on its trimmed text.
function trimmed(fields, name) {
    const value = fields[name];
    return value === null || value === undefined ? '' : String(value).trim();
}

// A fraction of supply in (0, 1], the QUORUM and DECIDE_THRESHOLD shape.
function isSupplyFraction(validator, text) {
    const n = Number(text);
    return validator.util.isNumeric(text) && n > 0 && n <= 1;
}

function isPositiveAmount(validator, text) {
    return validator.util.isNumeric(text) && validator.util.bcnum(text).gt(0);
}

// A wire amount as an exact decimal, or null when the field is absent or not numeric.
function wireAmount(validator, fields, name) {
    const text = trimmed(fields, name);
    return text !== '' && validator.util.isNumeric(text) ? validator.util.bcnum(text) : null;
}

// The XBRIDGE format a request will serialize as: its VERSION, or the selector's pick.
function xbridgeVersion(validator, fields) {
    if (!validator.isEmpty(fields.VERSION)) return Number(fields.VERSION);
    try { return FormatSelector.select('XBRIDGE', fields).version; } catch (e) { return null; }
}

module.exports = {
    // A GATE_MIN_AMOUNT with no GATE_TICKER is refused, not ignored
    // (xchain-indexer/src/actions/file.js): a threshold with no gate to weigh a
    // balance against must not be storable.
    validateFileGatePairing(fields) {
        if (!this.isEmpty(fields.GATE_MIN_AMOUNT) && this.isEmpty(fields.GATE_TICKER))
            return [this.buildError('INVALID_FIELD_VALUE',
                'GATE_MIN_AMOUNT requires GATE_TICKER (a threshold with no gate is refused)',
                { field: 'GATE_MIN_AMOUNT' })];
        return [];
    },

    // DISPENSER v0 fiat pricing pairs (xchain-indexer/src/actions/dispenser/validate.js).
    // Both fields exist on the create format alone, so their presence is that format.
    validateDispenserFiatPairing(fields) {
        if (!this.isEmpty(fields.DISPENSER_ACTION_INDEX)) return [];
        const errors = [];
        if (!this.isEmpty(fields.FIAT_AMOUNT) && this.isEmpty(fields.FIAT_CODE))
            errors.push(this.buildError('MISSING_REQUIRED_FIELD',
                'DISPENSER FIAT_AMOUNT requires FIAT_CODE', { field: 'FIAT_CODE' }));
        if (!this.isEmpty(fields.FIAT_CODE) && this.isEmpty(fields.FIAT_AMOUNT) && this.isEmpty(fields.ORACLE_ADDRESS))
            errors.push(this.buildError('MISSING_REQUIRED_FIELD',
                'DISPENSER FIAT_CODE requires FIAT_AMOUNT unless ORACLE_ADDRESS prices it', { field: 'FIAT_AMOUNT' }));
        return errors;
    },

    // VOTE v0 poll rules decidable from the wire (xchain-indexer/src/actions/vote/
    // validate.js validateCreatePollRules and validateCreateThresholds, index.js
    // parseCreate defaults). Chain-side only, and so not checked here: TICK names
    // an issued token the creator holds, END_BLOCK is above the including block,
    // DEPOSIT is funded, and a binding CALLBACK_CONTRACT exists, is active and
    // exposes CALLBACK_METHOD.
    validateVoteCreate(fields) {
        const errors = [];
        const bad = (field, message) => errors.push(this.buildError('INVALID_FIELD_VALUE', message, { action: 'VOTE', version: 0, field }));
        const endBlock = trimmed(fields, 'END_BLOCK');
        if (endBlock !== '' && !this.util.isNumeric(endBlock))
            bad('END_BLOCK', 'VOTE END_BLOCK must be a block number');
        const options = trimmed(fields, 'OPTIONS').split(',').map(o => o.trim()).filter(o => o.length > 0);
        if (trimmed(fields, 'OPTIONS') !== '' && options.length < 2)
            bad('OPTIONS', 'VOTE OPTIONS needs at least 2 non-empty, comma-separated entries');
        // An absent MAX_SELECTIONS defaults to 1 on chain. Judged only once OPTIONS
        // is usable, since the chain stops at the OPTIONS refusal first.
        const maxSelections = Number(trimmed(fields, 'MAX_SELECTIONS') || '1');
        if (options.length >= 2 && (!Number.isInteger(maxSelections) || maxSelections < 1 || maxSelections > options.length))
            bad('MAX_SELECTIONS', 'VOTE MAX_SELECTIONS must be an integer from 1 to the number of OPTIONS');
        const tally = trimmed(fields, 'TALLY_MODE');
        if (tally !== '' && !TALLY_MODES.includes(tally))
            bad('TALLY_MODE', 'VOTE TALLY_MODE must be one of: ' + TALLY_MODES.join(', ') + ' (lower case)');
        const weight = trimmed(fields, 'WEIGHT_MODE');
        if (weight !== '' && !WEIGHT_MODES.includes(weight))
            bad('WEIGHT_MODE', 'VOTE WEIGHT_MODE must be one of: ' + WEIGHT_MODES.join(', ') + ' (lower case)');
        if (weight === 'quadratic' && !isPositiveAmount(this, trimmed(fields, 'MIN_VOTE_BALANCE')))
            bad('MIN_VOTE_BALANCE', 'VOTE quadratic WEIGHT_MODE requires MIN_VOTE_BALANCE > 0');
        errors.push(...this.validateVoteThresholds(fields));
        errors.push(...this.validateVoteCallback(fields));
        return errors;
    },

    // The optional thresholds and the free-text QUESTION of a VOTE v0 poll.
    validateVoteThresholds(fields) {
        const errors = [];
        const bad = (field, message) => errors.push(this.buildError('INVALID_FIELD_VALUE', message, { action: 'VOTE', version: 0, field }));
        for (const field of ['QUORUM', 'DECIDE_THRESHOLD']) {
            const text = trimmed(fields, field);
            if (text !== '' && !isSupplyFraction(this, text))
                bad(field, 'VOTE ' + field + ' must be a fraction of supply above 0 and at most 1');
        }
        const minVoters = trimmed(fields, 'MIN_VOTERS');
        if (minVoters !== '' && (!Number.isInteger(Number(minVoters)) || Number(minVoters) < 0))
            bad('MIN_VOTERS', 'VOTE MIN_VOTERS must be a non-negative integer');
        const minBalance = trimmed(fields, 'MIN_VOTE_BALANCE');
        if (minBalance !== '' && (!this.util.isNumeric(minBalance) || this.util.bcnum(minBalance).lt(0)))
            bad('MIN_VOTE_BALANCE', 'VOTE MIN_VOTE_BALANCE must be a non-negative amount');
        if (trimmed(fields, 'QUESTION').length > MAX_MESSAGE_LENGTH)
            bad('QUESTION', 'VOTE QUESTION must be ' + MAX_MESSAGE_LENGTH + ' characters or less');
        return errors;
    },

    // ISSUE orderings (xchain-indexer/src/actions/issue/supply_rules.js
    // validateMintSupplyCaps and edit_rules.js validateMintWindowAndMemo). The chain
    // compares the ISSUE merged with the token row, so a rule runs here only when every
    // value it compares is on the wire. MAX_SUPPLY 0 is the uncapped sentinel on some
    // planes and a cap on others (UNCAPPED_MAX_SUPPLY_ZERO), so the supply comparisons
    // need a positive one. The cumulative supply cap reads existing supply: chain-side.
    validateIssueCrossFields(fields) {
        const errors = [];
        const bad = (field, message) => errors.push(this.buildError('INVALID_FIELD_VALUE', message, { action: 'ISSUE', field }));
        const maxSupply = wireAmount(this, fields, 'MAX_SUPPLY');
        const mintSupply = wireAmount(this, fields, 'MINT_SUPPLY');
        const maxMint = wireAmount(this, fields, 'MAX_MINT');
        const addressMax = wireAmount(this, fields, 'MINT_ADDRESS_MAX');
        const start = wireAmount(this, fields, 'MINT_START_BLOCK');
        const stop = wireAmount(this, fields, 'MINT_STOP_BLOCK');
        const capped = maxSupply !== null && maxSupply.gt(0);
        if (capped && mintSupply !== null && mintSupply.gt(maxSupply))
            bad('MINT_SUPPLY', 'ISSUE MINT_SUPPLY cannot exceed MAX_SUPPLY');
        if (capped && addressMax !== null && addressMax.gt(0) && addressMax.gt(maxSupply))
            bad('MINT_ADDRESS_MAX', 'ISSUE MINT_ADDRESS_MAX cannot exceed MAX_SUPPLY');
        if (addressMax !== null && addressMax.gt(0) && maxMint !== null && addressMax.lt(maxMint))
            bad('MINT_ADDRESS_MAX', 'ISSUE MINT_ADDRESS_MAX cannot be below MAX_MINT');
        if (start !== null && stop !== null && start.gt(0) && stop.gt(0) && stop.lt(start))
            bad('MINT_STOP_BLOCK', 'ISSUE MINT_STOP_BLOCK cannot be before MINT_START_BLOCK');
        return errors;
    },

    // XBRIDGE chain and tick-shape rules (xchain-indexer/src/actions/xbridge/validate.js
    // validateChainRules and validateTickShape): pure functions of the wire and the coin,
    // run before any token read. v0 locks into the BTC escrow, so BTC only; v1 burns a
    // foreign copy, so never on BTC; v4 burns a bridged copy '<ORIGIN>.<NAME>' of another
    // chain; v3 locks a native, undotted tick short enough to root as '<COIN>.<TICK>'.
    // Whether the tick opted into the destination is its row's: chain-side. Without a
    // resolved coin nothing is asserted.
    validateXbridgeShape(fields) {
        const { coin } = networkPlane(this);
        const version = xbridgeVersion(this, fields);
        if (!coin || version === null) return [];
        const bad = (field, message) => [this.buildError('INVALID_FIELD_VALUE', message, { action: 'XBRIDGE', version, field })];
        if (version === 0 && coin !== 'BTC') return bad('VERSION', 'XBRIDGE v0 is valid only on BTC');
        if (version === 1 && coin === 'BTC') return bad('VERSION', 'XBRIDGE v1 is not valid on BTC');
        const tick = trimmed(fields, 'TICK');
        if (tick === '' || (version !== 3 && version !== 4)) return [];
        const bridged = this.util.parseBridgedTick(tick, coin);
        if (version === 4)
            return bridged ? [] : bad('TICK', 'XBRIDGE v4 TICK must be a bridged copy <ORIGIN>.<NAME> of another chain');
        if (bridged) return bad('TICK', 'XBRIDGE v3 TICK is a bridged copy; burn it with XBRIDGE v4');
        if (tick.includes('.')) return bad('TICK', 'XBRIDGE v3: subassets are not bridgeable yet');
        if (coin.length + 1 + tick.length > MAX_TICK_LENGTH)
            return bad('TICK', 'XBRIDGE v3 TICK is too long to bridge (' + coin + '.' + tick + ' exceeds ' + MAX_TICK_LENGTH + ')');
        return [];
    },

    // Binding-poll callback fields (xchain-indexer/src/actions/vote/binding_callback.js
    // and the GAS_ESCROW rule in index.js parseCreate).
    validateVoteCallback(fields) {
        const errors = [];
        const bad = (field, message) => errors.push(this.buildError('INVALID_FIELD_VALUE', message, { action: 'VOTE', version: 0, field }));
        const binding = trimmed(fields, 'CALLBACK_CONTRACT') !== '';
        if (binding) {
            const method = fields.CALLBACK_METHOD === null || fields.CALLBACK_METHOD === undefined ? '' : String(fields.CALLBACK_METHOD);
            if (method.trim() === '')
                bad('CALLBACK_METHOD', 'VOTE CALLBACK_METHOD is required for a binding poll');
            else if (method.length > MAX_CALLBACK_METHOD_LENGTH)
                bad('CALLBACK_METHOD', 'VOTE CALLBACK_METHOD must be ' + MAX_CALLBACK_METHOD_LENGTH + ' characters or less');
            const on = trimmed(fields, 'CALLBACK_ON');
            if (on !== '' && on !== 'pass' && on !== 'always')
                bad('CALLBACK_ON', 'VOTE CALLBACK_ON must be pass or always');
        } else if (isPositiveAmount(this, trimmed(fields, 'GAS_ESCROW'))) {
            bad('GAS_ESCROW', 'VOTE GAS_ESCROW requires CALLBACK_CONTRACT');
        }
        return errors;
    },
};
