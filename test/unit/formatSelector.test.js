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
 * XChain Platform SDK - FormatSelector Tests
 *
 * Comprehensive Mocha + Chai test suite for the FormatSelector class.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const FormatSelector = require('../../src/formatSelector.js');
const { SDKFormatError } = require('../../src/errors.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fields object from an array of key names, all set to a short
 * placeholder value, plus any extra overrides.
 */
function fields(...keys) {
    const obj = {};
    for (const key of keys) obj[key] = 'x';
    return obj;
}


// ===========================================================================
// select() - basic selection for each action type
// ===========================================================================

describe('FormatSelector.select(): basic action-type selection', function () {

    // -------------------------------------------------------------------------
    // SEND
    // -------------------------------------------------------------------------
    describe('SEND', function () {

        it('selects v0 for TICK + AMOUNT + DESTINATION', function () {
            const result = FormatSelector.select('SEND', {
                TICK: 'TOKEN', AMOUNT: '100', DESTINATION: 'addr1'
            });
            expect(result.version).to.equal(0);
        });

        it('selects v0 for TICK + AMOUNT + DESTINATION + MEMO', function () {
            const result = FormatSelector.select('SEND', {
                TICK: 'TOKEN', AMOUNT: '100', DESTINATION: 'addr1', MEMO: 'hello'
            });
            expect(result.version).to.equal(0);
        });

    });

    // -------------------------------------------------------------------------
    // ISSUE
    // -------------------------------------------------------------------------
    describe('ISSUE', function () {

        it('selects v1 (shortest) for TICK + DESCRIPTION', function () {
            // v1: VERSION|TICK|DESCRIPTION|MEMO  (much shorter than v0)
            const result = FormatSelector.select('ISSUE', {
                TICK: 'TOKEN', DESCRIPTION: 'My token'
            });
            expect(result.version).to.equal(1);
        });

        it('selects v0 for TICK + MAX_SUPPLY + MAX_MINT + DECIMALS', function () {
            // DECIMALS only exists in v0
            const result = FormatSelector.select('ISSUE', {
                TICK: 'TOKEN', MAX_SUPPLY: '21000000', MAX_MINT: '1000', DECIMALS: '8'
            });
            expect(result.version).to.equal(0);
        });

        it('selects v3 for TICK + 7 LOCK fields', function () {
            // v3: VERSION|TICK|LOCK_MAX_SUPPLY|LOCK_MAX_MINT|LOCK_DESCRIPTION|LOCK_SLEEP|LOCK_CALLBACK|LOCK_MINT|LOCK_MINT_SUPPLY|MEMO
            const result = FormatSelector.select('ISSUE', {
                TICK: 'TOKEN',
                LOCK_MAX_SUPPLY: '1',
                LOCK_MAX_MINT: '1',
                LOCK_DESCRIPTION: '1',
                LOCK_SLEEP: '1',
                LOCK_CALLBACK: '1',
                LOCK_MINT: '1',
                LOCK_MINT_SUPPLY: '1'
            });
            expect(result.version).to.equal(3);
        });

        it('selects v4 for TICK + CALLBACK_BLOCK + CALLBACK_TICK + CALLBACK_AMOUNT', function () {
            // v4: VERSION|TICK|CALLBACK_BLOCK|CALLBACK_TICK|CALLBACK_AMOUNT|MEMO
            const result = FormatSelector.select('ISSUE', {
                TICK: 'TOKEN', CALLBACK_BLOCK: '800000', CALLBACK_TICK: 'CTOK', CALLBACK_AMOUNT: '50'
            });
            expect(result.version).to.equal(4);
        });

        it('selects v5 for TICK + ALLOW_LIST + BLOCK_LIST', function () {
            // v5: VERSION|TICK|ALLOW_LIST|BLOCK_LIST|MEMO (shorter than v0)
            const result = FormatSelector.select('ISSUE', {
                TICK: 'TOKEN', ALLOW_LIST: '1', BLOCK_LIST: '2'
            });
            expect(result.version).to.equal(5);
        });

    });

    // -------------------------------------------------------------------------
    // ORDER
    // -------------------------------------------------------------------------
    describe('ORDER', function () {

        it('selects v1 for ORDER_ACTION_INDEX only', function () {
            // v1: VERSION|ORDER_ACTION_INDEX|MEMO
            const result = FormatSelector.select('ORDER', { ORDER_ACTION_INDEX: '42' });
            expect(result.version).to.equal(1);
        });

        it('selects v2 for ORDER_ACTION_INDEX + EXPIRATION + ALLOW_LIST + BLOCK_LIST', function () {
            // v2: VERSION|ORDER_ACTION_INDEX|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO
            const result = FormatSelector.select('ORDER', {
                ORDER_ACTION_INDEX: '42', EXPIRATION: '1000', ALLOW_LIST: '1', BLOCK_LIST: '2'
            });
            expect(result.version).to.equal(2);
        });

    });

    // -------------------------------------------------------------------------
    // SWAP
    // -------------------------------------------------------------------------
    describe('SWAP', function () {

        it('selects v1 for SWAP_ACTION_INDEX', function () {
            // v1: VERSION|SWAP_ACTION_INDEX|MEMO
            const result = FormatSelector.select('SWAP', { SWAP_ACTION_INDEX: '7' });
            expect(result.version).to.equal(1);
        });

    });

    // -------------------------------------------------------------------------
    // DISPENSER
    // -------------------------------------------------------------------------
    describe('DISPENSER', function () {

        it('selects v1 for DISPENSER_ACTION_INDEX', function () {
            // v1: VERSION|DISPENSER_ACTION_INDEX|MEMO
            const result = FormatSelector.select('DISPENSER', { DISPENSER_ACTION_INDEX: '99' });
            expect(result.version).to.equal(1);
        });

    });

    // -------------------------------------------------------------------------
    // SLEEP
    // -------------------------------------------------------------------------
    describe('SLEEP', function () {

        it('selects v0 for RESUME_BLOCK only', function () {
            // v0: VERSION|RESUME_BLOCK|MEMO  (shorter than v1)
            const result = FormatSelector.select('SLEEP', { RESUME_BLOCK: '900000' });
            expect(result.version).to.equal(0);
        });

        it('selects v1 for RESUME_BLOCK + TICK', function () {
            // v1: VERSION|RESUME_BLOCK|TICK|MEMO (only format with TICK slot)
            const result = FormatSelector.select('SLEEP', { RESUME_BLOCK: '900000', TICK: 'TOKEN' });
            expect(result.version).to.equal(1);
        });

    });

    // -------------------------------------------------------------------------
    // BROADCAST
    // -------------------------------------------------------------------------
    describe('BROADCAST', function () {

        it('selects v0 for MESSAGE + VALUE', function () {
            // v0: VERSION|MESSAGE|VALUE  (shorter than v1)
            const result = FormatSelector.select('BROADCAST', { MESSAGE: 'hello', VALUE: '100' });
            expect(result.version).to.equal(0);
        });

        it('selects v2 for MESSAGE + FEE (no VALUE)', function () {
            // v2: VERSION|MESSAGE|FEE|MEMO
            // v0 has no FEE field; v1 has VALUE before FEE; v2 fits FEE without VALUE
            const result = FormatSelector.select('BROADCAST', { MESSAGE: 'hello', FEE: '5' });
            expect(result.version).to.equal(2);
        });

    });

});


// ===========================================================================
// select() - picks the smallest (shortest) format
// ===========================================================================

describe('FormatSelector.select(): picks the smallest format', function () {

    it('selects v1 (shorter than v0) for ISSUE with only TICK', function () {
        // v1 = VERSION|TICK|DESCRIPTION|MEMO  (4 fields)
        // v0 = VERSION|TICK|...<25 fields total>
        // TICK fits in both; v1 is far shorter
        const result = FormatSelector.select('ISSUE', { TICK: 'TOKEN' });
        expect(result.version).to.equal(1);
    });

    it('selects v0 (shorter) for DESTROY with TICK + AMOUNT', function () {
        // v0: VERSION|TICK|AMOUNT|MEMO
        // v1: VERSION|TICK|AMOUNT|TICK|AMOUNT|MEMO  (repeated unique slots)
        // v2: VERSION|TICK|AMOUNT|MEMO|TICK|AMOUNT|MEMO  (even longer)
        // All three accept TICK+AMOUNT; v0 produces the shortest output
        const result = FormatSelector.select('DESTROY', { TICK: 'TOKEN', AMOUNT: '500' });
        expect(result.version).to.equal(0);
    });

});


// ===========================================================================
// select() - return structure
// ===========================================================================

describe('FormatSelector.select(): return structure', function () {

    it('returns an object with version, formatFields, and estimatedLength', function () {
        const result = FormatSelector.select('SEND', {
            TICK: 'TOKEN', AMOUNT: '100', DESTINATION: 'addr1'
        });
        expect(result).to.be.an('object');
        expect(result).to.have.property('version').that.is.a('number');
        expect(result).to.have.property('formatFields').that.is.an('array');
        expect(result).to.have.property('estimatedLength').that.is.a('number');
    });

    it('formatFields contains VERSION as the first element', function () {
        const result = FormatSelector.select('SEND', { TICK: 'TOKEN', AMOUNT: '10', DESTINATION: 'addr1' });
        expect(result.formatFields[0]).to.equal('VERSION');
    });

    it('estimatedLength is a positive integer', function () {
        const result = FormatSelector.select('SEND', { TICK: 'TOKEN', AMOUNT: '10', DESTINATION: 'addr1' });
        expect(result.estimatedLength).to.be.a('number');
        expect(result.estimatedLength).to.be.greaterThan(0);
        expect(Number.isInteger(result.estimatedLength)).to.be.true;
    });

});


// ===========================================================================
// select() - error cases
// ===========================================================================

describe('FormatSelector.select(): error cases', function () {

    it('throws SDKFormatError with code UNKNOWN_ACTION for an unrecognised action', function () {
        expect(() => FormatSelector.select('NONEXISTENT', {}))
            .to.throw(SDKFormatError)
            .and.satisfy(err => err.code === 'UNKNOWN_ACTION');
    });

    it('thrown UNKNOWN_ACTION error includes the action name in details', function () {
        let caught;
        try {
            FormatSelector.select('FAKE_ACTION', {});
        } catch (err) {
            caught = err;
        }
        expect(caught).to.be.instanceOf(SDKFormatError);
        expect(caught.code).to.equal('UNKNOWN_ACTION');
        expect(caught.details).to.have.property('action', 'FAKE_ACTION');
    });

    it('throws SDKFormatError with code NO_MATCHING_FORMAT when a field fits no format', function () {
        // FAKE_FIELD does not exist in any SEND format
        expect(() => FormatSelector.select('SEND', { TICK: 'TOKEN', AMOUNT: '100', DESTINATION: 'addr1', FAKE_FIELD: 'x' }))
            .to.throw(SDKFormatError)
            .and.satisfy(err => err.code === 'NO_MATCHING_FORMAT');
    });

    it('NO_MATCHING_FORMAT error includes action and populatedFields in details', function () {
        let caught;
        try {
            FormatSelector.select('SEND', { TICK: 'TOKEN', FAKE_FIELD: 'x' });
        } catch (err) {
            caught = err;
        }
        expect(caught).to.be.instanceOf(SDKFormatError);
        expect(caught.code).to.equal('NO_MATCHING_FORMAT');
        expect(caught.details).to.have.property('action', 'SEND');
        expect(caught.details).to.have.property('populatedFields').that.is.an('array');
        expect(caught.details.populatedFields).to.include('FAKE_FIELD');
    });

    it('NO_MATCHING_FORMAT error includes availableFormats describing rejection reasons', function () {
        let caught;
        try {
            FormatSelector.select('SEND', { TICK: 'TOKEN', FAKE_FIELD: 'x' });
        } catch (err) {
            caught = err;
        }
        expect(caught.details).to.have.property('availableFormats').that.is.an('object');
    });

    it('throws SDKFormatError (not a generic Error) for unknown action', function () {
        let caught;
        try {
            FormatSelector.select('DOES_NOT_EXIST', {});
        } catch (err) {
            caught = err;
        }
        expect(caught).to.be.instanceOf(SDKFormatError);
        expect(caught.name).to.equal('SDKFormatError');
    });

});


// ===========================================================================
// serialize() - basic serialization
// ===========================================================================

describe('FormatSelector.serialize(): basic serialization', function () {

    it('serializes SEND v0 with TICK, AMOUNT, DESTINATION', function () {
        const result = FormatSelector.serialize('SEND', 0, {
            TICK: 'TOKEN', AMOUNT: '100', DESTINATION: 'addr1'
        });
        expect(result).to.equal('SEND|0|TOKEN|100|addr1');
    });

    it('serializes SEND v0 with TICK, AMOUNT, DESTINATION, MEMO', function () {
        const result = FormatSelector.serialize('SEND', 0, {
            TICK: 'TOKEN', AMOUNT: '100', DESTINATION: 'addr1', MEMO: 'memo text'
        });
        expect(result).to.equal('SEND|0|TOKEN|100|addr1|memo text');
    });

    it('serializes BROADCAST v0 with MESSAGE + VALUE', function () {
        const result = FormatSelector.serialize('BROADCAST', 0, {
            MESSAGE: 'hello', VALUE: '100'
        });
        expect(result).to.equal('BROADCAST|0|hello|100');
    });

    it('serializes ISSUE v1 with TICK + DESCRIPTION', function () {
        const result = FormatSelector.serialize('ISSUE', 1, {
            TICK: 'TOKEN', DESCRIPTION: 'A test token'
        });
        expect(result).to.equal('ISSUE|1|TOKEN|A test token');
    });

    it('serializes SLEEP v0 with RESUME_BLOCK', function () {
        const result = FormatSelector.serialize('SLEEP', 0, { RESUME_BLOCK: '900000' });
        expect(result).to.equal('SLEEP|0|900000');
    });

});


// ===========================================================================
// serialize() - trailing empty fields are trimmed
// ===========================================================================

describe('FormatSelector.serialize(): trailing empty fields are trimmed', function () {

    it('SEND v0 without MEMO has no trailing pipe', function () {
        const result = FormatSelector.serialize('SEND', 0, {
            TICK: 'TOKEN', AMOUNT: '100', DESTINATION: 'addr1'
        });
        expect(result).to.equal('SEND|0|TOKEN|100|addr1');
        expect(result.endsWith('|')).to.be.false;
    });

    it('SWEEP v0 with only DESTINATION trims trailing empty fields', function () {
        // v0: VERSION|DESTINATION|BALANCES|OWNERSHIPS|ORDERS|SWAPS|DISPENSERS|MEMO
        // All flags and MEMO are empty → trimmed
        const result = FormatSelector.serialize('SWEEP', 0, { DESTINATION: 'myaddr' });
        expect(result).to.equal('SWEEP|0|myaddr');
        expect(result.endsWith('|')).to.be.false;
    });

    it('BROADCAST v0 with only MESSAGE trims empty VALUE', function () {
        // v0: VERSION|MESSAGE|VALUE (VALUE is empty and trailing, so trimmed)
        const result = FormatSelector.serialize('BROADCAST', 0, { MESSAGE: 'ping' });
        expect(result).to.equal('BROADCAST|0|ping');
    });

    it('does not trim fields that are empty but not trailing', function () {
        // SLEEP v1: VERSION|RESUME_BLOCK|TICK|MEMO
        // If RESUME_BLOCK is provided and TICK is empty but MEMO is provided,
        // TICK must appear as an empty segment between them.
        const result = FormatSelector.serialize('SLEEP', 1, {
            RESUME_BLOCK: '800000', TICK: '', MEMO: 'wake up'
        });
        expect(result).to.equal('SLEEP|1|800000||wake up');
    });

});


// ===========================================================================
// serialize() - VERSION is auto-populated
// ===========================================================================

describe('FormatSelector.serialize(): VERSION is auto-populated', function () {

    it('VERSION appears as the first pipe-separated field after the action name', function () {
        const result = FormatSelector.serialize('SEND', 0, {
            TICK: 'TOKEN', AMOUNT: '1', DESTINATION: 'addr1'
        });
        const parts = result.split('|');
        // parts[0] = action name, parts[1] = VERSION value
        expect(parts[0]).to.equal('SEND');
        expect(parts[1]).to.equal('0');
    });

    it('correct version number appears for v1', function () {
        const result = FormatSelector.serialize('ISSUE', 1, { TICK: 'TOKEN' });
        const parts = result.split('|');
        expect(parts[1]).to.equal('1');
    });

    it('correct version number appears for v3', function () {
        // SEND v3 is a repeated-field format, so it is built from LEGS
        const result = FormatSelector.serialize('SEND', 3, {
            LEGS: [{ TICK: 'TOKEN', AMOUNT: '1', DESTINATION: 'addr1' }]
        });
        const parts = result.split('|');
        expect(parts[1]).to.equal('3');
    });

});


// ===========================================================================
// serialize() - empty / missing fields become empty strings between pipes
// ===========================================================================

describe('FormatSelector.serialize(): empty / missing fields become empty strings', function () {

    it('ORDER v0 with GIVE_TICK and GET_TICK but no GIVE_COIN produces empty segment for GIVE_COIN', function () {
        // v0: VERSION|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_OWNERSHIP|GET_COIN|GET_TICK|GET_AMOUNT|GET_OWNERSHIP|GET_ADDRESS|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO
        const result = FormatSelector.serialize('ORDER', 0, {
            GIVE_TICK: 'TOK1',
            GET_TICK: 'TOK2'
        });
        const parts = result.split('|');
        // parts[0]=ORDER, parts[1]=0, parts[2]=GIVE_COIN, parts[3]=GIVE_TICK, parts[4]=GIVE_AMOUNT, parts[5]=GIVE_OWNERSHIP, parts[6]=GET_COIN, parts[7]=GET_TICK
        expect(parts[2]).to.equal('');      // GIVE_COIN is empty
        expect(parts[3]).to.equal('TOK1'); // GIVE_TICK is present
        expect(parts[4]).to.equal('');      // GIVE_AMOUNT is empty
        expect(parts[5]).to.equal('');      // GIVE_OWNERSHIP is empty
        expect(parts[6]).to.equal('');      // GET_COIN is empty
        expect(parts[7]).to.equal('TOK2'); // GET_TICK is present
    });

    it('undefined field becomes empty string', function () {
        const result = FormatSelector.serialize('SEND', 0, {
            TICK: 'TOKEN', AMOUNT: undefined, DESTINATION: 'addr1'
        });
        const parts = result.split('|');
        // parts: SEND|0|TOKEN||addr1
        expect(parts[3]).to.equal(''); // AMOUNT is undefined → empty string
        expect(parts[4]).to.equal('addr1');
    });

    it('null field becomes empty string', function () {
        const result = FormatSelector.serialize('SEND', 0, {
            TICK: 'TOKEN', AMOUNT: null, DESTINATION: 'addr1'
        });
        const parts = result.split('|');
        expect(parts[3]).to.equal(''); // AMOUNT is null → empty string
    });

});


// ===========================================================================
// getFormatFields()
// ===========================================================================

describe('FormatSelector.getFormatFields()', function () {

    it('returns correct ordered array for SEND v0', function () {
        const result = FormatSelector.getFormatFields('SEND', 0);
        expect(result).to.deep.equal(['VERSION', 'TICK', 'AMOUNT', 'DESTINATION', 'MEMO']);
    });

    it('returns correct ordered array for ISSUE v1', function () {
        const result = FormatSelector.getFormatFields('ISSUE', 1);
        expect(result).to.deep.equal(['VERSION', 'TICK', 'DESCRIPTION', 'MEMO']);
    });

    it('returns correct ordered array for SLEEP v0', function () {
        const result = FormatSelector.getFormatFields('SLEEP', 0);
        expect(result).to.deep.equal(['VERSION', 'RESUME_BLOCK', 'MEMO']);
    });

    it('returns correct ordered array for SLEEP v1', function () {
        const result = FormatSelector.getFormatFields('SLEEP', 1);
        expect(result).to.deep.equal(['VERSION', 'RESUME_BLOCK', 'TICK', 'MEMO']);
    });

    it('returns array (not a string)', function () {
        const result = FormatSelector.getFormatFields('SEND', 0);
        expect(result).to.be.an('array');
    });

    it('repeating-field formats include duplicates in the array', function () {
        // SEND v1: VERSION|TICK|AMOUNT|DESTINATION|AMOUNT|DESTINATION|MEMO
        const result = FormatSelector.getFormatFields('SEND', 1);
        const amountCount = result.filter(f => f === 'AMOUNT').length;
        const destCount = result.filter(f => f === 'DESTINATION').length;
        expect(amountCount).to.equal(2);
        expect(destCount).to.equal(2);
    });

});


// ===========================================================================
// getPopulatedFields()
// ===========================================================================

describe('FormatSelector.getPopulatedFields()', function () {

    it('returns keys whose values are non-null, non-undefined, non-empty strings', function () {
        const result = FormatSelector.getPopulatedFields({
            TICK: 'TOKEN', AMOUNT: '100', DESTINATION: 'addr1'
        });
        expect(result).to.include.members(['TICK', 'AMOUNT', 'DESTINATION']);
        expect(result).to.have.length(3);
    });

    it('filters out null values', function () {
        const result = FormatSelector.getPopulatedFields({ TICK: 'TOKEN', AMOUNT: null });
        expect(result).to.deep.equal(['TICK']);
    });

    it('filters out undefined values', function () {
        const result = FormatSelector.getPopulatedFields({ TICK: 'TOKEN', AMOUNT: undefined });
        expect(result).to.deep.equal(['TICK']);
    });

    it('filters out empty string values', function () {
        const result = FormatSelector.getPopulatedFields({ TICK: 'TOKEN', AMOUNT: '' });
        expect(result).to.deep.equal(['TICK']);
    });

    it('returns an empty array when all fields are empty', function () {
        const result = FormatSelector.getPopulatedFields({ TICK: null, AMOUNT: undefined, MEMO: '' });
        expect(result).to.deep.equal([]);
    });

    it('returns an empty array for an empty object', function () {
        const result = FormatSelector.getPopulatedFields({});
        expect(result).to.deep.equal([]);
    });

    it('includes fields with numeric zero value (0)', function () {
        // 0 is not null/undefined/empty-string, so it should be kept
        const result = FormatSelector.getPopulatedFields({ DECIMALS: 0, TICK: 'TOKEN' });
        expect(result).to.include('DECIMALS');
    });

    it('includes fields with boolean false value', function () {
        // false is not null/undefined/empty-string, so it should be kept
        const result = FormatSelector.getPopulatedFields({ LOCK_MINT: false, TICK: 'TOKEN' });
        expect(result).to.include('LOCK_MINT');
    });

});


// ===========================================================================
// estimateLength()
// ===========================================================================

describe('FormatSelector.estimateLength()', function () {

    it('returns a positive integer', function () {
        const len = FormatSelector.estimateLength('SEND', 0, {
            TICK: 'TOKEN', AMOUNT: '100', DESTINATION: 'addr1'
        });
        expect(len).to.be.a('number');
        expect(len).to.be.greaterThan(0);
        expect(Number.isInteger(len)).to.be.true;
    });

    it('computes correct byte count for SEND v0 with TOKEN/100/addr1', function () {
        // FORMAT: SEND|VERSION|TICK|AMOUNT|DESTINATION|MEMO
        // Serialized (trailing MEMO trimmed): SEND|0|TOKEN|100|addr1
        // estimateLength does NOT trim; it counts all fields including trailing empty ones.
        // Fields: VERSION=0(1), TICK=TOKEN(5), AMOUNT=100(3), DESTINATION=addr1(5), MEMO='empty'(0)
        // Pipes between fields: 4 (one between each of the 5 format fields)
        // action prefix: SEND|(5 chars)
        // total = 5 + 1 + 5 + 3 + 5 + 0 + 4 = 23
        const len = FormatSelector.estimateLength('SEND', 0, {
            TICK: 'TOKEN', AMOUNT: '100', DESTINATION: 'addr1'
        });
        expect(len).to.equal(23);
    });

    it('longer field values produce larger estimates', function () {
        const short = FormatSelector.estimateLength('SEND', 0, {
            TICK: 'A', AMOUNT: '1', DESTINATION: 'B'
        });
        const long = FormatSelector.estimateLength('SEND', 0, {
            TICK: 'LONGTOKEN', AMOUNT: '999999999', DESTINATION: 'a_very_long_address_string'
        });
        expect(long).to.be.greaterThan(short);
    });

    it('returns a smaller estimate for a shorter format version', function () {
        // ISSUE v1 (4 fields) vs ISSUE v0 (25 fields) with only TICK populated
        const lenV1 = FormatSelector.estimateLength('ISSUE', 1, { TICK: 'TOKEN' });
        const lenV0 = FormatSelector.estimateLength('ISSUE', 0, { TICK: 'TOKEN' });
        expect(lenV1).to.be.lessThan(lenV0);
    });

    it('is consistent with actual serialized output length (no trailing trim)', function () {
        // estimateLength counts all format slots including trailing empty ones, so it may be
        // >= the trimmed serialized length. Confirm it is at least as large.
        const fields = { TICK: 'TOKEN', AMOUNT: '50', DESTINATION: 'addr1' };
        const estimated = FormatSelector.estimateLength('SEND', 0, fields);
        const serialized = FormatSelector.serialize('SEND', 0, fields);
        expect(estimated).to.be.at.least(serialized.length);
    });

});

// ─── Explicit version + rest-field handling ──────────────────────────────────
describe('FormatSelector: explicit version + rest fields', function () {

    it('honours a valid explicit version', function () {
        const result = FormatSelector.select('SEND', { TICK: 'X', AMOUNT: '1', DESTINATION: 'a' }, 0);
        expect(result.version).to.equal(0);
    });

    it('throws INVALID_VERSION for an undefined explicit version', function () {
        expect(() => FormatSelector.select('SEND', { TICK: 'X' }, 99))
            .to.throw(SDKFormatError).that.has.property('code', 'INVALID_VERSION');
    });

    it('serialize expands a rest-field into individual pipe segments', function () {
        // DEPLOY v0 = VERSION|CODE_ENCODING|GAS_LIMIT|...CONSTRUCTOR_PARAMS
        const out = FormatSelector.serialize('DEPLOY', 0, {
            CODE_ENCODING: 'base64', GAS_LIMIT: '100', CONSTRUCTOR_PARAMS: ['a', 'b', 'c'],
        });
        expect(out).to.equal('DEPLOY|0|base64|100|a|b|c');
    });

    it('serialize emits nothing for an empty/absent rest-field array', function () {
        const out = FormatSelector.serialize('DEPLOY', 0, { CODE_ENCODING: 'base64', GAS_LIMIT: '100' });
        expect(out).to.equal('DEPLOY|0|base64|100');
    });

    it('serialize coerces null/undefined rest-field items to empty segments', function () {
        const out = FormatSelector.serialize('DEPLOY', 0, {
            CODE_ENCODING: 'b', GAS_LIMIT: '1', CONSTRUCTOR_PARAMS: ['x', null, 'z'],
        });
        expect(out).to.equal('DEPLOY|0|b|1|x||z');
    });

    it('estimateLength accounts for rest-field array contents', function () {
        const withParams = FormatSelector.estimateLength('DEPLOY', 0, {
            CODE_ENCODING: 'base64', GAS_LIMIT: '100', CONSTRUCTOR_PARAMS: ['aaaa', 'bbbb'],
        });
        const without = FormatSelector.estimateLength('DEPLOY', 0, {
            CODE_ENCODING: 'base64', GAS_LIMIT: '100',
        });
        expect(withParams).to.be.greaterThan(without);
    });
});
