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

const { expect } = require('chai');
const { SDKValidationError } = require('../../src/utils/errors.js');
const { ADDR, createActions } = require('./actions.test/helpers/create_actions.js');


// All 19 ACTION types - basic smoke tests

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
    // The child commands carry REAL addresses: BATCH children are now validated
    // through the authoritative action path, so the old 'addr1'/'addr2'
    // placeholders are rejected the same way a chain would reject them.
    it('BATCH produces correct actionString', function () {
        let cmd = 'SEND|0|TOKEN|100|' + ADDR + ';SEND|0|TOKEN|200|' + ADDR;
        let result = actions.createAction({
            action: 'BATCH',
            params: { command: cmd }
        });
        expect(result.actionString).to.match(/^BATCH\|/);
        expect(result.actionString).to.include(cmd);
    });

});

describe('Actions – all 19 ACTION types', function () {

    let actions;
    beforeEach(function () { actions = createActions(); });

    // A raw COMMAND string used to be counted, never parsed: only parts[0] was
    // read, so an unknown action or a bad field value was serialized, encoded
    // and paid for before the chain rejected it.
    it('BATCH REJECTS a child command naming an unknown action', function () {
        expect(() => actions.createAction({
            action: 'BATCH',
            params: { command: 'NOTREAL|0|x' }
        })).to.throw(SDKValidationError, /BATCH command 0 is not a valid action: UNKNOWN_ACTION/);
    });

    it('BATCH REJECTS a child command with an invalid field value', function () {
        expect(() => actions.createAction({
            action: 'BATCH',
            params: { command: 'SEND|0|TOKEN|100|' + ADDR + ';SEND|0|TOKEN|-5|' + ADDR }
        })).to.throw(SDKValidationError, /BATCH command 1 \(SEND\): AMOUNT must be a positive number/);
    });

    it('BATCH still accepts compacted ^id ticker and address references', function () {
        let result = actions.createAction({
            action: 'BATCH',
            params: { command: 'SEND|0|^12|100|^7' }
        });
        expect(result.actionString).to.include('SEND|0|^12|100|^7');
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

});


describe('Actions – all 19 ACTION types', function () {

    let actions;
    beforeEach(function () { actions = createActions(); });

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

});


describe('Actions – all 19 ACTION types', function () {

    let actions;
    beforeEach(function () { actions = createActions(); });

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

});


describe('Actions – all 19 ACTION types', function () {

    let actions;
    beforeEach(function () { actions = createActions(); });

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

});


describe('Actions – all 19 ACTION types', function () {

    let actions;
    beforeEach(function () { actions = createActions(); });

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
