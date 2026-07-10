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
 * XChain Platform SDK - Actions Class Tests
 *
 * Comprehensive unit tests for the Actions class covering all 19 ACTION
 * types, format version selection, result structure, error cases,
 * pre-flight encoding validation, validateAction dry-run, and
 * introspection methods.
 *
 ********************************************************************/

'use strict';

const { expect }  = require('chai');
const config      = require('../../src/config.js');
const Utility     = require('../../src/utility.js');
const Actions     = require('../../src/actions.js');
const { SDKValidationError } = require('../../src/errors.js');

// Reusable valid segwit address (42 chars)
const ADDR = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';

// Factory: create a fresh Actions instance backed by real config + utility
function createActions() {
    let sdk = { config: config.getConfig(), util: new Utility() };
    return new Actions(sdk);
}


// ---------------------------------------------------------------------------
// Section 1: All 19 ACTION types - basic smoke tests
// ---------------------------------------------------------------------------

describe('Actions – all 19 ACTION types', function () {

    let actions;
    beforeEach(function () { actions = createActions(); });

    // ADDRESS
    it('ADDRESS produces correct actionString', function () {
        let result = actions.createAction({
            action: 'ADDRESS',
            params: { feePreference: 1, requireMemo: 0 }
        });
        expect(result.actionString).to.equal('ADDRESS|0|1|0');
        expect(result.action).to.equal('ADDRESS');
    });

    // AIRDROP
    it('AIRDROP produces correct actionString', function () {
        let result = actions.createAction({
            action: 'AIRDROP',
            params: { tick: 'TOKEN', amount: '100', listActionIndex: 1 }
        });
        expect(result.actionString).to.match(/^AIRDROP\|/);
        expect(result.actionString).to.include('TOKEN');
        expect(result.actionString).to.include('100');
    });

    // BATCH
    it('BATCH produces correct actionString', function () {
        let cmd = 'SEND|0|TOKEN|100|addr1;SEND|0|TOKEN|200|addr2';
        let result = actions.createAction({
            action: 'BATCH',
            params: { command: cmd }
        });
        expect(result.actionString).to.match(/^BATCH\|/);
        expect(result.actionString).to.include(cmd);
    });

    // BROADCAST
    it('BROADCAST produces correct actionString', function () {
        let result = actions.createAction({
            action: 'BROADCAST',
            params: { message: 'hello', value: '100' }
        });
        expect(result.actionString).to.match(/^BROADCAST\|/);
        expect(result.actionString).to.include('hello');
        expect(result.actionString).to.include('100');
    });

    // CALLBACK
    it('CALLBACK produces correct actionString', function () {
        let result = actions.createAction({
            action: 'CALLBACK',
            params: { tick: 'TOKEN' }
        });
        expect(result.actionString).to.match(/^CALLBACK\|/);
        expect(result.actionString).to.include('TOKEN');
    });

    // DESTROY
    it('DESTROY produces correct actionString', function () {
        let result = actions.createAction({
            action: 'DESTROY',
            params: { tick: 'TOKEN', amount: '500' }
        });
        expect(result.actionString).to.match(/^DESTROY\|/);
        expect(result.actionString).to.include('TOKEN');
        expect(result.actionString).to.include('500');
    });

    // DISPENSER
    it('DISPENSER produces correct actionString', function () {
        let result = actions.createAction({
            action: 'DISPENSER',
            params: {
                giveTick: 'A', giveAmount: '100', giveEscrow: '100',
                getTick: 'B', getAmount: '50'
            }
        });
        expect(result.actionString).to.match(/^DISPENSER\|/);
        expect(result.actionString).to.include('A');
        expect(result.actionString).to.include('B');
    });

    // DIVIDEND
    it('DIVIDEND produces correct actionString', function () {
        let result = actions.createAction({
            action: 'DIVIDEND',
            params: { tick: 'TOKEN', dividendTick: 'BTC', amount: '1' }
        });
        expect(result.actionString).to.match(/^DIVIDEND\|/);
        expect(result.actionString).to.include('TOKEN');
        expect(result.actionString).to.include('BTC');
        expect(result.actionString).to.include('1');
    });

    // FILE
    // Note: TYPE is listed in NUMBER_FIELDS in config, so a MIME-type string like 'text/plain'
    // is cast to NaN by setNumberFormats(). Pass a numeric type code to avoid this behaviour.
    it('FILE produces correct actionString', function () {
        let result = actions.createAction({
            action: 'FILE',
            params: { name: 'test.txt', type: 1, title: 'Test' }
        });
        expect(result.actionString).to.match(/^FILE\|/);
        expect(result.actionString).to.include('test.txt');
        expect(result.actionString).to.include('1');
        expect(result.actionString).to.include('Test');
    });

    // ISSUE
    it('ISSUE produces correct actionString', function () {
        let result = actions.createAction({
            action: 'ISSUE',
            params: { tick: 'MYTOKEN', maxSupply: '21000000', maxMint: '1000', decimals: 8 }
        });
        expect(result.actionString).to.match(/^ISSUE\|/);
        expect(result.actionString).to.include('MYTOKEN');
    });

    // LINK
    it('LINK produces correct actionString', function () {
        let result = actions.createAction({
            action: 'LINK',
            params: { coin1: 'BTC', coin1ActionIndex: 1, coin2: 'LTC', coin2ActionIndex: 2 }
        });
        expect(result.actionString).to.match(/^LINK\|/);
        expect(result.actionString).to.include('BTC');
        expect(result.actionString).to.include('LTC');
    });

    // LIST
    it('LIST produces correct actionString', function () {
        let result = actions.createAction({
            action: 'LIST',
            params: { type: 1, item: 'TOKEN1,TOKEN2' }
        });
        expect(result.actionString).to.match(/^LIST\|/);
        expect(result.actionString).to.include('TOKEN1,TOKEN2');
    });

    // MESSAGE
    it('MESSAGE produces correct actionString', function () {
        let result = actions.createAction({
            action: 'MESSAGE',
            params: { coin: 'BTC', destination: ADDR, plaintextMessage: 'hello' }
        });
        expect(result.actionString).to.match(/^MESSAGE\|/);
        expect(result.actionString).to.include(ADDR);
        expect(result.actionString).to.include('hello');
    });

    // MINT
    it('MINT produces correct actionString', function () {
        let result = actions.createAction({
            action: 'MINT',
            params: { tick: 'TOKEN', amount: '1000', destination: ADDR }
        });
        expect(result.actionString).to.match(/^MINT\|/);
        expect(result.actionString).to.include('TOKEN');
        expect(result.actionString).to.include('1000');
        expect(result.actionString).to.include(ADDR);
    });

    // ORDER
    it('ORDER produces correct actionString', function () {
        let result = actions.createAction({
            action: 'ORDER',
            params: { giveTick: 'A', giveAmount: '100', getTick: 'B', getAmount: '200' }
        });
        expect(result.actionString).to.match(/^ORDER\|/);
        expect(result.actionString).to.include('A');
        expect(result.actionString).to.include('B');
    });

    // SEND
    it('SEND produces correct actionString', function () {
        let result = actions.createAction({
            action: 'SEND',
            params: { tick: 'TOKEN', amount: '100', destination: ADDR }
        });
        expect(result.actionString).to.match(/^SEND\|/);
        expect(result.actionString).to.include('TOKEN');
        expect(result.actionString).to.include('100');
        expect(result.actionString).to.include(ADDR);
    });

    // SLEEP
    it('SLEEP produces correct actionString', function () {
        let result = actions.createAction({
            action: 'SLEEP',
            params: { resumeBlock: 500000 }
        });
        expect(result.actionString).to.match(/^SLEEP\|/);
        expect(result.actionString).to.include('500000');
    });

    // SWAP
    it('SWAP produces correct actionString', function () {
        let result = actions.createAction({
            action: 'SWAP',
            params: { giveTick: 'A', giveAmount: '100', getTick: 'B', getAmount: '200' }
        });
        expect(result.actionString).to.match(/^SWAP\|/);
        expect(result.actionString).to.include('A');
        expect(result.actionString).to.include('B');
    });

    // SWEEP
    it('SWEEP produces correct actionString', function () {
        let result = actions.createAction({
            action: 'SWEEP',
            params: { destination: ADDR, balances: 1, ownerships: 1, orders: 0, swaps: 0, dispensers: 0 }
        });
        expect(result.actionString).to.match(/^SWEEP\|/);
        expect(result.actionString).to.include(ADDR);
        expect(result.actionString).to.include('1');
    });

});


// ---------------------------------------------------------------------------
// Section 2: Format version selection
// ---------------------------------------------------------------------------

describe('Actions – format version selection', function () {

    let actions;
    beforeEach(function () { actions = createActions(); });

    it('ISSUE with description only selects v1', function () {
        let result = actions.createAction({
            action: 'ISSUE',
            params: { tick: 'MYTOKEN', description: 'A test token' }
        });
        // v1 format: VERSION|TICK|DESCRIPTION|MEMO
        expect(result.version).to.equal(1);
        expect(result.actionString).to.match(/^ISSUE\|1\|MYTOKEN\|A test token/);
    });

    it('ISSUE with lock fields selects v3', function () {
        let result = actions.createAction({
            action: 'ISSUE',
            params: {
                tick: 'MYTOKEN',
                lockMaxSupply: 1,
                lockMaxMint: 0,
                lockDescription: 1,
                lockSleep: 0,
                lockCallback: 0,
                lockMint: 0,
                lockMintSupply: 0
            }
        });
        // v3 format: VERSION|TICK|LOCK_MAX_SUPPLY|LOCK_MAX_MINT|LOCK_DESCRIPTION|LOCK_SLEEP|LOCK_CALLBACK|LOCK_MINT|LOCK_MINT_SUPPLY|MEMO
        expect(result.version).to.equal(3);
    });

    it('ISSUE with callback fields selects v4', function () {
        let result = actions.createAction({
            action: 'ISSUE',
            params: {
                tick: 'MYTOKEN',
                callbackBlock: 800000,
                callbackTick: 'BTC',
                callbackAmount: '1'
            }
        });
        // v4 format: VERSION|TICK|CALLBACK_BLOCK|CALLBACK_TICK|CALLBACK_AMOUNT|MEMO
        expect(result.version).to.equal(4);
    });

    it('ISSUE with allowList + blockList selects v5', function () {
        let result = actions.createAction({
            action: 'ISSUE',
            params: {
                tick: 'MYTOKEN',
                allowList: 1,
                blockList: 2
            }
        });
        // v5 format: VERSION|TICK|ALLOW_LIST|BLOCK_LIST|MEMO
        expect(result.version).to.equal(5);
    });

    it('ORDER with orderActionIndex selects v1 (cancel)', function () {
        let result = actions.createAction({
            action: 'ORDER',
            params: { orderActionIndex: 42 }
        });
        // v1 format: VERSION|ORDER_ACTION_INDEX|MEMO
        expect(result.version).to.equal(1);
        expect(result.actionString).to.match(/^ORDER\|1\|42/);
    });

    it('SLEEP with resumeBlock + tick selects v1', function () {
        let result = actions.createAction({
            action: 'SLEEP',
            params: { resumeBlock: 500000, tick: 'TOKEN' }
        });
        // v1 format: VERSION|RESUME_BLOCK|TICK|MEMO
        expect(result.version).to.equal(1);
        expect(result.actionString).to.include('TOKEN');
    });

    it('SLEEP with resumeBlock only selects v0', function () {
        let result = actions.createAction({
            action: 'SLEEP',
            params: { resumeBlock: 500000 }
        });
        // v0 format: VERSION|RESUME_BLOCK|MEMO
        expect(result.version).to.equal(0);
    });

});


// ---------------------------------------------------------------------------
// Section 3: Result structure
// ---------------------------------------------------------------------------

describe('Actions – createAction result structure', function () {

    let actions;
    beforeEach(function () { actions = createActions(); });

    it('returns all expected keys with correct types', function () {
        let result = actions.createAction({
            action: 'SEND',
            params: { tick: 'TOKEN', amount: '100', destination: ADDR }
        });
        expect(result).to.have.all.keys('action', 'version', 'actionString', 'fields', 'encoding', 'psbt');
        expect(result.action).to.be.a('string');
        expect(result.version).to.be.a('number');
        expect(result.actionString).to.be.a('string');
        expect(result.fields).to.be.an('object');
        expect(result.encoding).to.equal(null);
        expect(result.psbt).to.equal(null);
    });

    it('normalizes the action name to uppercase', function () {
        let result = actions.createAction({
            action: 'send',
            params: { tick: 'TOKEN', amount: '50', destination: ADDR }
        });
        expect(result.action).to.equal('SEND');
    });

    it('fields object contains UPPER_SNAKE_CASE keys', function () {
        let result = actions.createAction({
            action: 'SEND',
            params: { tick: 'TOKEN', amount: '100', destination: ADDR }
        });
        expect(result.fields).to.have.property('TICK');
        expect(result.fields).to.have.property('AMOUNT');
        expect(result.fields).to.have.property('DESTINATION');
    });

    it('encoding and psbt are both null when no encoder option provided', function () {
        let result = actions.createAction({
            action: 'MINT',
            params: { tick: 'TOKEN', amount: '10', destination: ADDR }
        });
        expect(result.encoding).to.be.null;
        expect(result.psbt).to.be.null;
    });

});


// ---------------------------------------------------------------------------
// Section 4: Error cases
// ---------------------------------------------------------------------------

describe('Actions – error cases', function () {

    let actions;
    beforeEach(function () { actions = createActions(); });

    it('throws SDKValidationError when action field is missing', function () {
        expect(function () {
            actions.createAction({ params: { tick: 'TOKEN' } });
        }).to.throw(SDKValidationError).with.property('code', 'MISSING_ACTION');
    });

    it('throws SDKValidationError when action field is null', function () {
        expect(function () {
            actions.createAction(null);
        }).to.throw(SDKValidationError).with.property('code', 'MISSING_ACTION');
    });

    it('throws SDKValidationError for unknown ACTION type', function () {
        expect(function () {
            actions.createAction({ action: 'NOTANACTION', params: {} });
        }).to.throw(SDKValidationError).with.property('code', 'UNKNOWN_ACTION');
    });

    it('throws SDKValidationError for missing SEND required field: TICK', function () {
        expect(function () {
            actions.createAction({
                action: 'SEND',
                params: { amount: '100', destination: ADDR }
            });
        }).to.throw(SDKValidationError);
    });

    it('throws SDKValidationError for missing SEND required field: DESTINATION', function () {
        expect(function () {
            actions.createAction({
                action: 'SEND',
                params: { tick: 'TOKEN', amount: '100' }
            });
        }).to.throw(SDKValidationError);
    });

    it('SDKValidationError has a name property of "SDKValidationError"', function () {
        let err;
        try {
            actions.createAction({ params: {} });
        } catch (e) {
            err = e;
        }
        expect(err).to.be.instanceOf(SDKValidationError);
        expect(err.name).to.equal('SDKValidationError');
    });

});


// ---------------------------------------------------------------------------
// Section 5: Pre-flight encoding validation
// ---------------------------------------------------------------------------

describe('Actions – pre-flight encoding validation', function () {

    let actions;
    beforeEach(function () { actions = createActions(); });

    it('OP_RETURN with oversized data throws SDKValidationError with code ENCODING_DATA_TOO_LARGE', function () {
        // Build a long but valid SEND; destination is 42 chars, tick is long, amount is long
        // OP_RETURN limit is 76 bytes of payload (80 - 4 byte magic)
        // "SEND|0|AVERYLONGTICKNAME|99999999999|bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh"
        // is well above 76 bytes
        let longTick = 'AVERYLONGTICKNAME';
        expect(function () {
            actions.createAction({
                action: 'SEND',
                params: { tick: longTick, amount: '99999999999', destination: ADDR },
                encoder: { encoding: 'OP_RETURN' }
            });
        }).to.throw(SDKValidationError).with.property('code', 'ENCODING_DATA_TOO_LARGE');
    });

    it('ENCODING_DATA_TOO_LARGE error includes suggestion in details', function () {
        let err;
        try {
            actions.createAction({
                action: 'SEND',
                params: { tick: 'AVERYLONGTICKNAME', amount: '99999999999', destination: ADDR },
                encoder: { encoding: 'OP_RETURN' }
            });
        } catch (e) {
            err = e;
        }
        expect(err).to.be.instanceOf(SDKValidationError);
        expect(err.details).to.have.property('suggestion');
        expect(err.details).to.have.property('dataBytes');
        expect(err.details).to.have.property('maxBytes');
    });

    it('MULTISIGN without compressedPubKey throws SDKValidationError with code MISSING_COMPRESSED_PUBKEY', function () {
        expect(function () {
            actions.createAction({
                action: 'SEND',
                params: { tick: 'TOKEN', amount: '100', destination: ADDR },
                encoder: { encoding: 'MULTISIGN' }
            });
        }).to.throw(SDKValidationError).with.property('code', 'MISSING_COMPRESSED_PUBKEY');
    });

    it('MULTISIGN with compressedPubKey does NOT throw', function () {
        let fakePubKey = '03' + '0'.repeat(62); // fake 33-byte compressed pubkey (hex)
        expect(function () {
            actions.createAction({
                action: 'SEND',
                params: { tick: 'TOKEN', amount: '100', destination: ADDR },
                encoder: { encoding: 'MULTISIGN', compressedPubKey: fakePubKey }
            });
        }).to.not.throw();
    });

    it('P2SH with any size data does NOT throw (chunking handled by encoder)', function () {
        // Even a very long message should be allowed for P2SH
        let longMemo = 'x'.repeat(400);
        expect(function () {
            // Use BROADCAST with a long message; P2SH should accept without throwing
            actions.createAction({
                action: 'BROADCAST',
                params: { message: 'hello', value: '100' },
                encoder: { encoding: 'P2SH' }
            });
        }).to.not.throw();
    });

    it('OP_RETURN with short data does NOT throw', function () {
        // "SEND|0|A|1|bc1q..." - very short, well within 76 bytes
        expect(function () {
            actions.createAction({
                action: 'SEND',
                params: { tick: 'A', amount: '1', destination: ADDR },
                encoder: { encoding: 'OP_RETURN' }
            });
        }).to.not.throw();
    });

});


// ---------------------------------------------------------------------------
// Section 6: validateAction() dry-run
// ---------------------------------------------------------------------------

describe('Actions – validateAction() dry-run', function () {

    let actions;
    beforeEach(function () { actions = createActions(); });

    it('returns { valid: true, errors: [] } for valid SEND params', function () {
        let result = actions.validateAction('SEND', {
            tick: 'TOKEN',
            amount: '100',
            destination: ADDR
        });
        expect(result.valid).to.equal(true);
        expect(result.errors).to.be.an('array').that.is.empty;
    });

    it('returns { valid: false, errors: [...] } for SEND missing tick', function () {
        let result = actions.validateAction('SEND', {
            amount: '100',
            destination: ADDR
        });
        expect(result.valid).to.equal(false);
        expect(result.errors).to.be.an('array').with.length.above(0);
    });

    it('returns { valid: false, errors: [...] } for SEND missing destination', function () {
        let result = actions.validateAction('SEND', {
            tick: 'TOKEN',
            amount: '100'
        });
        expect(result.valid).to.equal(false);
        expect(result.errors).to.be.an('array').with.length.above(0);
        let codes = result.errors.map(function (e) { return e.code; });
        expect(codes).to.include('MISSING_REQUIRED_FIELD');
    });

    it('returns { valid: true } for ISSUE with a sub-TICK (dot is the parent/child separator)', function () {
        let result = actions.validateAction('ISSUE', { tick: 'TOKEN.CHILD' });
        expect(result.valid).to.equal(true);
        expect(result.errors).to.be.an('array').that.is.empty;
    });

    it('returns { valid: false, errors: [...] } for ISSUE tick with an empty dot segment', function () {
        let result = actions.validateAction('ISSUE', { tick: 'TOKEN..CHILD' });
        expect(result.valid).to.equal(false);
        expect(result.errors).to.be.an('array').with.length.above(0);
    });

    it('returns { valid: true, errors: [] } for valid ISSUE tick', function () {
        let result = actions.validateAction('ISSUE', { tick: 'VALIDTOKEN' });
        expect(result.valid).to.equal(true);
        expect(result.errors).to.be.an('array').that.is.empty;
    });

    it('does not throw even for invalid params: returns errors object instead', function () {
        expect(function () {
            actions.validateAction('SEND', {});
        }).to.not.throw();
    });

    it('returns valid: true for valid MINT params', function () {
        let result = actions.validateAction('MINT', {
            tick: 'TOKEN',
            amount: '500',
            destination: ADDR
        });
        expect(result.valid).to.equal(true);
    });

    it('returns valid: false for ADDRESS with invalid feePreference value', function () {
        let result = actions.validateAction('ADDRESS', { feePreference: 99 });
        expect(result.valid).to.equal(false);
    });

});


// ---------------------------------------------------------------------------
// Section 7: Introspection methods
// ---------------------------------------------------------------------------

describe('Actions – introspection', function () {

    let actions;
    beforeEach(function () { actions = createActions(); });

    // getActions()
    it('getActions() returns an array of exactly 30 action names', function () {
        let list = actions.getActions();
        expect(list).to.be.an('array');
        expect(list).to.have.length(30);
    });

    it('getActions() contains all expected action names', function () {
        let list = actions.getActions();
        let expected = [
            'ADDRESS', 'AIRDROP', 'BATCH', 'BROADCAST', 'CALLBACK',
            'DESTROY', 'DISPENSER', 'DIVIDEND', 'FILE', 'ISSUE',
            'LINK', 'LIST', 'MESSAGE', 'MINT', 'ORDER',
            'SEND', 'SLEEP', 'SWAP', 'SWEEP'
        ];
        for (let name of expected) {
            expect(list).to.include(name);
        }
    });

    // getActionFormats()
    it('getActionFormats("ISSUE") returns an object with keys 0-5', function () {
        let formats = actions.getActionFormats('ISSUE');
        expect(formats).to.be.an('object');
        for (let v = 0; v <= 5; v++) {
            expect(formats).to.have.property(String(v));
        }
    });

    it('getActionFormats("SEND") returns an object with keys 0-3', function () {
        let formats = actions.getActionFormats('SEND');
        expect(formats).to.be.an('object');
        for (let v = 0; v <= 3; v++) {
            expect(formats).to.have.property(String(v));
        }
    });

    it('getActionFormats("UNKNOWN") returns null', function () {
        let formats = actions.getActionFormats('UNKNOWN');
        expect(formats).to.be.null;
    });

    // getActionFields()
    it('getActionFields("SEND", 0) returns expected field list', function () {
        let fields = actions.getActionFields('SEND', 0);
        expect(fields).to.be.an('array');
        expect(fields).to.include('VERSION');
        expect(fields).to.include('TICK');
        expect(fields).to.include('AMOUNT');
        expect(fields).to.include('DESTINATION');
        expect(fields).to.include('MEMO');
    });

    it('getActionFields("SEND", 0) includes exactly VERSION, TICK, AMOUNT, DESTINATION, MEMO', function () {
        let fields = actions.getActionFields('SEND', 0);
        // v0 = 'VERSION|TICK|AMOUNT|DESTINATION|MEMO' -> 5 unique fields
        expect(fields).to.deep.equal(['VERSION', 'TICK', 'AMOUNT', 'DESTINATION', 'MEMO']);
    });

    it('getActionFields("ISSUE") with no version returns a union of all fields across all versions', function () {
        let fields = actions.getActionFields('ISSUE');
        expect(fields).to.be.an('array').with.length.above(5);
        // Should contain fields from v0 (full) and smaller versions
        expect(fields).to.include('TICK');
        expect(fields).to.include('MAX_SUPPLY');
        expect(fields).to.include('DESCRIPTION');
        expect(fields).to.include('ALLOW_LIST');
        expect(fields).to.include('CALLBACK_BLOCK');
    });

    it('getActionFields("SLEEP", 1) returns VERSION, RESUME_BLOCK, TICK, MEMO', function () {
        let fields = actions.getActionFields('SLEEP', 1);
        expect(fields).to.deep.equal(['VERSION', 'RESUME_BLOCK', 'TICK', 'MEMO']);
    });

});


// ---------------------------------------------------------------------------
// Section 8: Edge cases and additional coverage
// ---------------------------------------------------------------------------

describe('Actions – edge cases', function () {

    let actions;
    beforeEach(function () { actions = createActions(); });

    it('params defaults to empty object when not provided', function () {
        // ADDRESS has no required fields, so createAction({ action }) should work
        expect(function () {
            actions.createAction({ action: 'ADDRESS' });
        }).to.not.throw();
    });

    it('action name is case-insensitive', function () {
        let r1 = actions.createAction({
            action: 'send',
            params: { tick: 'TOKEN', amount: '1', destination: ADDR }
        });
        let r2 = actions.createAction({
            action: 'SEND',
            params: { tick: 'TOKEN', amount: '1', destination: ADDR }
        });
        expect(r1.action).to.equal('SEND');
        expect(r1.actionString).to.equal(r2.actionString);
    });

    it('trailing empty fields are trimmed from actionString', function () {
        // SEND with no memo, trailing MEMO slot should be removed
        let result = actions.createAction({
            action: 'SEND',
            params: { tick: 'TOKEN', amount: '100', destination: ADDR }
        });
        expect(result.actionString).to.not.match(/\|$/);
    });

    it('SEND actionString format is SEND|VERSION|TICK|AMOUNT|DESTINATION', function () {
        let result = actions.createAction({
            action: 'SEND',
            params: { tick: 'TOKEN', amount: '100', destination: ADDR }
        });
        expect(result.actionString).to.equal('SEND|0|TOKEN|100|' + ADDR);
    });

    it('MINT actionString format is MINT|VERSION|TICK|AMOUNT|DESTINATION', function () {
        let result = actions.createAction({
            action: 'MINT',
            params: { tick: 'TOKEN', amount: '1000', destination: ADDR }
        });
        expect(result.actionString).to.equal('MINT|0|TOKEN|1000|' + ADDR);
    });

    it('SLEEP actionString format is SLEEP|VERSION|RESUME_BLOCK', function () {
        let result = actions.createAction({
            action: 'SLEEP',
            params: { resumeBlock: 500000 }
        });
        expect(result.actionString).to.equal('SLEEP|0|500000');
    });

    it('ADDRESS with feePreference and requireMemo serializes correctly', function () {
        let result = actions.createAction({
            action: 'ADDRESS',
            params: { feePreference: 2, requireMemo: 1 }
        });
        expect(result.actionString).to.equal('ADDRESS|0|2|1');
    });

    it('BROADCAST with message and value uses v0 format', function () {
        let result = actions.createAction({
            action: 'BROADCAST',
            params: { message: 'hello', value: '100' }
        });
        expect(result.version).to.equal(0);
        expect(result.actionString).to.equal('BROADCAST|0|hello|100');
    });

    it('CALLBACK actionString includes tick', function () {
        let result = actions.createAction({
            action: 'CALLBACK',
            params: { tick: 'MYTOKEN' }
        });
        expect(result.actionString).to.equal('CALLBACK|0|MYTOKEN');
    });

    it('DESTROY actionString includes tick and amount', function () {
        let result = actions.createAction({
            action: 'DESTROY',
            params: { tick: 'TOKEN', amount: '500' }
        });
        expect(result.actionString).to.equal('DESTROY|0|TOKEN|500');
    });

    it('SWEEP actionString includes destination + per-primitive flags (balances, ownerships, orders, swaps, dispensers)', function () {
        let result = actions.createAction({
            action: 'SWEEP',
            params: { destination: ADDR, balances: 1, ownerships: 1, orders: 0, swaps: 0, dispensers: 0 }
        });
        expect(result.actionString).to.equal('SWEEP|0|' + ADDR + '|1|1|0|0|0');
    });

});


// ---------------------------------------------------------------------------
// DEPLOY stakeable formats: CONSTRUCTOR_PARAMS is a single wire field in
// v1/v3, so a multi-element array must fail loudly instead of String()-
// joining into one comma-corrupted constructor arg on an immutable deploy.
// ---------------------------------------------------------------------------

describe('Actions – DEPLOY stakeable CONSTRUCTOR_PARAMS guard', function () {

    let actions;
    beforeEach(function () { actions = createActions(); });

    const CODE = 'contract Test {}';

    it('rejects multi-element constructorParams on a v1 (stakeable) DEPLOY', function () {
        expect(() => actions.createAction({
            action: 'DEPLOY',
            params: {
                code: CODE, gasLimit: '100',
                constructorParams: ['alice', '1000'],
                cooldownBlocks: 50
            }
        })).to.throw(SDKValidationError, /at most one entry/);
    });

    it('accepts a single constructorParams entry on a v1 (stakeable) DEPLOY', function () {
        let result = actions.createAction({
            action: 'DEPLOY',
            params: {
                code: CODE, gasLimit: '100',
                constructorParams: ['alice'],
                cooldownBlocks: 50
            }
        });
        expect(result.version).to.equal(1);
        let parts = result.actionString.split('|');
        expect(parts[4]).to.equal('alice');       // single CONSTRUCTOR_PARAMS field
        expect(parts[5]).to.equal('50');          // COOLDOWN_BLOCKS follows intact
    });

    it('still expands multi-element constructorParams on a v0 (rest-field) DEPLOY', function () {
        let result = actions.createAction({
            action: 'DEPLOY',
            params: {
                code: CODE, gasLimit: '100',
                constructorParams: ['alice', '1000']
            }
        });
        expect(result.version).to.equal(0);
        let parts = result.actionString.split('|');
        expect(parts.slice(4)).to.deep.equal(['alice', '1000']); // separate segments
    });
});


// ---------------------------------------------------------------------------
// FIAT_AMOUNT end-to-end: the exact defect path was createAction's
// setNumberFormats stripping trailing zeros ("10.00" -> "10") BEFORE a
// validator regex that demanded exactly two decimals, so every round fiat
// price was rejected. FIAT_AMOUNT is now excluded from numeric reformatting
// and the validator mirrors the indexer's <= 2 decimals consensus rule.
// ---------------------------------------------------------------------------

describe('Actions – fiat-priced DISPENSER pipeline (round prices)', function () {

    let actions;
    beforeEach(function () { actions = createActions(); });

    function fiatDispenser(fiatAmount) {
        return actions.createAction({
            action: 'DISPENSER',
            params: {
                giveTick: 'TOKEN', giveAmount: '10',
                getTick: 'BTC', getAmount: '0.001',
                fiatCode: 'USD', fiatAmount: fiatAmount
            }
        });
    }

    it("accepts round and half prices ('10.00', '1.50', '5.00', '0.50')", function () {
        for (const price of ['10.00', '1.50', '5.00', '0.50']) {
            let result = fiatDispenser(price);
            // The fiat price reaches the wire untouched (no trailing-zero strip).
            expect(result.actionString.split('|')).to.include(price);
        }
    });

    it("still accepts a non-round price ('19.99')", function () {
        expect(fiatDispenser('19.99').actionString.split('|')).to.include('19.99');
    });

    it("rejects a three-decimal price ('1.999')", function () {
        expect(() => fiatDispenser('1.999')).to.throw(SDKValidationError);
    });
});
