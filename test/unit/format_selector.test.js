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
const FormatSelector = require('../../src/protocol/format_selector.js');
const { SDKFormatError } = require('../../src/utils/errors.js');

// Helpers

/**
 * Build a fields object from an array of key names, all set to a short
 * placeholder value, plus any extra overrides.
 */
function fields(...keys) {
    const obj = {};
    for (const key of keys) obj[key] = 'x';
    return obj;
}


// select() - basic selection for each action type

describe('FormatSelector.select(): basic action-type selection', function () {

    // SEND
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
});

describe('FormatSelector.select(): basic action-type selection', function () {

    // ISSUE
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
});

describe('FormatSelector.select(): basic action-type selection', function () {

    // ORDER
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

    // SWAP
    describe('SWAP', function () {

        it('selects v1 for SWAP_ACTION_INDEX', function () {
            // v1: VERSION|SWAP_ACTION_INDEX|MEMO
            const result = FormatSelector.select('SWAP', { SWAP_ACTION_INDEX: '7' });
            expect(result.version).to.equal(1);
        });

    });

    // DISPENSER
    describe('DISPENSER', function () {

        it('selects v1 for DISPENSER_ACTION_INDEX', function () {
            // v1: VERSION|DISPENSER_ACTION_INDEX|MEMO
            const result = FormatSelector.select('DISPENSER', { DISPENSER_ACTION_INDEX: '99' });
            expect(result.version).to.equal(1);
        });

    });
});

describe('FormatSelector.select(): basic action-type selection', function () {

    // SLEEP
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

    // BROADCAST
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
// select() - picks the smallest (shortest) format

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


// select() - return structure

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


// select() - error cases

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
});

describe('FormatSelector.select(): error cases', function () {

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


// serialize() - basic serialization

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
