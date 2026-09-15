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

const config = require('../../config.js');
const FormatSelector = require('../format_selector.js');
const { MAX_DEPLOY_CHUNKS } = require('../../contract/chunk_helper.js');
const { VALID_COINS, ACTION_REQUIRED_FIELDS } = require('./field_limits.js');

module.exports = {
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
    },

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
    },

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
    },

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
    },

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
    },

    _validateList(fields) {
        let errors = [];
        let isEdit = !this._isEmpty(fields.LIST_ACTION_INDEX) || !this._isEmpty(fields.EDIT);
        // LIST v0 (create) requires TYPE; LIST v1 (edit) requires EDIT + LIST_ACTION_INDEX
        if (!isEdit) {
            // Create mode: TYPE is required
            if (this._isEmpty(fields.TYPE))
                errors.push(this._error('MISSING_REQUIRED_FIELD', 'LIST create requires field: TYPE', { field: 'TYPE' }));
        }

        // TYPE 2 (ADDRESS list) item validation (xchain-bridge.md row 13,
        // xchain-token-bridge-policy.md row 7): every ITEM must be a real crypto
        // address for at least one supported coin, checked against ONE network
        // (never a roster of all three), so a mainnet address can never ride in
        // as one testnet/regtest happens to share a byte prefix with a different
        // coin, and vice versa.
        //
        // Edit mode is deliberately left unchecked: LIST v1 does not resend TYPE,
        // and the SDK holds no other state on which TYPE the list being edited
        // already carries. Guessing here would either be blind (skip always, same
        // as today) or wrong (assume ADDRESS and reject a legitimate TICK item);
        // the indexer, which does hold that state, is the arbiter for edits.
        if (!isEdit && Number(fields.TYPE) === 2)
            errors.push(...this._validateListAddressItems(fields));

        return errors;
    },

    // TYPE=2 LIST.ITEM validation, see _validateList for scope.
    _validateListAddressItems(fields) {
        let errors = [];
        let raw = fields.ITEM;
        if (this._isEmpty(raw)) return errors;
        let items = Array.isArray(raw) ? raw : [raw];
        for (let item of items) {
            if (this._isEmpty(item)) continue;
            // ^<id> reference to an already-indexed address. addressRefFields.js
            // marks LIST.ITEM `listType:true`: the indexer still assigns it an
            // address id like any other address-bearing field even though the SDK
            // never COMPACTS an ITEM to this form, so a caller-supplied ^id is a
            // legitimate item and is format-checked as a bare id, not as an address.
            if (String(item).charAt(0) === '^') {
                let id = String(item).substring(1);
                if (!this.util.isNumeric(id))
                    errors.push(this._error('INVALID_ADDRESS_ID', 'LIST ITEM ID reference must be numeric: ' + item, { field: 'ITEM', value: item }));
                continue;
            }
            if (!this._isValidListAddress(item))
                errors.push(this._error('INVALID_FIELD_VALUE',
                    'LIST ITEM must be a valid address' + (this.network ? ' on ' + this.network : '') +
                    ' for a supported coin (' + VALID_COINS.join(', ') + ')',
                    { field: 'ITEM', value: item }));
        }
        return errors;
    },

    // True when `address` is a well-formed address for AT LEAST ONE supported
    // coin on this.network. Checked coin-by-coin with the coin-aware
    // isCryptoAddress (never the length-only heuristic once a network is known):
    // each coin's own params gate on ITS OWN network's version bytes/HRP, so
    // looping a FIXED network across coins can only add coins that validate at
    // THAT network, never smuggle in a different network's address under cover
    // of a coin name the list carries no field for.
    //
    // Some version bytes are shared ACROSS coins on testnet/regtest by upstream
    // convention (BTC and LTC both use pubKeyHash 0x6f/scriptHash 0xc4 there, and
    // DOGE regtest reuses the same pair - see coins/BTC.js, LTC.js, DOGE.js).
    // That is a real, documented protocol-level ambiguity (which coin a
    // 0x6f-prefixed address belongs to cannot be told from the address alone),
    // not something a per-item check can resolve since LIST carries no per-item
    // coin field to disambiguate against; accepting the address as valid for
    // "some supported coin at this network" is the correct and only answer
    // available at this layer. Bech32 addresses carry no such ambiguity: every
    // coin's HRP is distinct per network (bc/tb/bcrt, ltc/tltc/rltc).
    //
    // Without a resolved network (no explicit constructor param, no NETWORK env
    // var) the SDK cannot know which byte table applies, so this falls back to
    // the historical length-only heuristic (isCryptoAddress's own doc comment)
    // rather than refusing every list-address action for a caller who never
    // configured one.
    _isValidListAddress(address) {
        if (!this.network)
            return this.util.isCryptoAddress(address);
        // `network` reaches us in either spelling: a bare tier ('regtest') from
        // NETWORK, or a chain id ('bitcoin-regtest') from sdk.options.network.
        // addressParams only knows the tier, so take the half after the dash on
        // the SDK-wide convention (XChainSDK.js:1295, endpoints.js:48). Without
        // this a chain-id caller matched no byte table and every address was
        // refused, which is how it first surfaced.
        let tier = String(this.network).includes('-')
            ? String(this.network).split('-')[1]
            : this.network;
        for (let coin of VALID_COINS) {
            if (this.util.isCryptoAddress(address, coin, tier))
                return true;
        }
        return false;
    },

    // VOTE-specific validation (version-dependent, mirroring _validateDeploy).
    // The raw vote() wrapper lets a caller hand-roll params, and VOTE's anchor fields
    // differ per version, so a flat ACTION_REQUIRED_FIELDS entry cannot express them.
    // Field lists track src/protocol/formats.js and xchain-documentation/protocol/actions/vote.md.
    _validateVote(fields) {
        let errors = [];
        let needs = (list, label) => {
            for (let field of list)
                if (this._isEmpty(fields[field]))
                    errors.push(this._error('MISSING_REQUIRED_FIELD',
                        label + ' requires field: ' + field, { action: 'VOTE', field }));
        };

        // An absent VERSION is auto-selected downstream, so resolve it through the
        // selector that will actually pick it rather than through a field heuristic.
        // A heuristic that only anchors on POLL_REF (v1) and DELEGATE_TO (v3) reads a
        // payload carrying NEITHER as un-checkable and passes it, but select() still
        // returns a version for that payload: it sorts the fitting formats by
        // serialized length, and v1 is the shortest, so `sdk.vote({})` built and paid
        // for a bare `VOTE|1` the indexer refuses as 'invalid: POLL_REF (format)'
        // Asking select() also keeps this from drifting when a format
        // is added or removed. A payload no format can carry throws NO_MATCHING_FORMAT
        // at serialization with its own diagnostic, so nothing is asserted here.
        let version = this._isEmpty(fields.VERSION) ? null : Number(fields.VERSION);
        if (version === null) {
            try { version = FormatSelector.select('VOTE', fields).version; }
            catch (e) { return errors; }
        }

        switch (version) {
            case 0:
                // Create poll. Every field after OPTIONS is optional.
                needs(['TICK', 'END_BLOCK', 'OPTIONS'], 'VOTE v0 (create poll)');
                break;
            case 1:
                // Cast ballot. MEMO is optional; the indexer rejects an empty BALLOT.
                needs(['POLL_REF', 'BALLOT'], 'VOTE v1 (cast ballot)');
                break;
            case 2:
                // Finalize is system-synthesized: the indexer rejects any user-broadcast
                // VOTE v2, and formats.js omits it, so fail here with the actionable reason
                // rather than at serialization with a bare unknown-version error.
                errors.push(this._error('VOTE_CONSTRAINT',
                    'VOTE v2 (finalize) is system-synthesized and cannot be authored; the indexer rejects a user-broadcast VOTE v2',
                    { action: 'VOTE', version: 2 }));
                break;
            case 3:
                // Set or clear delegation. DELEGATE_TO is deliberately NOT required: a blank
                // DELEGATE_TO is the documented way to clear a standing delegation.
                needs(['TICK'], 'VOTE v3 (delegation)');
                break;
        }
        return errors;
    },

    // DELEGATE-specific validation (version-dependent, mirroring _validateVote above).
    // ACTION_REQUIRED_FIELDS carried `DELEGATE: []`, and the flat table structurally
    // cannot express these: the rotate flavors (v0/v1) carry NEW_SIGNING_PUBKEY while
    // the revoke flavors (v2/v3) carry SIGNING_PUBKEY, so no field is common to all
    // four. An empty payload therefore auto-selected v0 and serialized `DELEGATE|0`,
    // which the indexer refuses as 'invalid: SIGNING_PUBKEY (required)' with the miner
    // fee already spent. Field lists track src/protocol/formats.js and
    // xchain-indexer/src/actions/delegate.js.
    _validateDelegate(fields) {
        let errors = [];
        let needs = (list, label) => {
            for (let field of list)
                if (this._isEmpty(fields[field]))
                    errors.push(this._error('MISSING_REQUIRED_FIELD',
                        label + ' requires field: ' + field, { action: 'DELEGATE', field }));
        };

        // An absent VERSION is auto-selected downstream, so anchor on the fields that
        // discriminate: SIGNING_PUBKEY means a revoke, TARGET_CONTRACT_INDEX/TICK mean
        // the contract-targeted pair. With nothing populated, auto-selection lands on
        // the smallest format (v0), which is what the caller is then held to.
        let version = this._isEmpty(fields.VERSION) ? null : Number(fields.VERSION);
        if (version === null) {
            let targeted = !this._isEmpty(fields.TARGET_CONTRACT_INDEX) || !this._isEmpty(fields.TICK);
            let revoke   = !this._isEmpty(fields.SIGNING_PUBKEY) && this._isEmpty(fields.NEW_SIGNING_PUBKEY);
            version      = (revoke ? 2 : 0) + (targeted ? 1 : 0);
        }

        switch (version) {
            case 0:
                needs(['NEW_SIGNING_PUBKEY'], 'DELEGATE v0 (capability rotate)');
                break;
            case 1:
                needs(['NEW_SIGNING_PUBKEY', 'TARGET_CONTRACT_INDEX', 'TICK'], 'DELEGATE v1 (contract-targeted rotate)');
                break;
            case 2:
                needs(['SIGNING_PUBKEY'], 'DELEGATE v2 (capability revoke)');
                break;
            case 3:
                needs(['SIGNING_PUBKEY', 'TARGET_CONTRACT_INDEX', 'TICK'], 'DELEGATE v3 (contract-targeted revoke)');
                break;
        }
        return errors;
    }
};
