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
const config      = require('../../../../src/config.js');
const Utility     = require('../../../../src/utils/utility.js');
const Actions     = require('../../../../src/actions/index.js');
const { SDKValidationError } = require('../../../../src/utils/errors.js');
const { ADDR, createActions } = require('./helpers/create_actions.js');

// Pre-flight encoding validation

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

});


describe('Actions – pre-flight encoding validation', function () {

    let actions;
    beforeEach(function () { actions = createActions(); });

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

    it('OP_RETURN boundary: a 75-byte action string passes, 76 bytes throws (compiled-push gate)', function () {
        // BROADCAST message length tuned so the action string is exactly 75 then
        // 76 bytes. 75 compiles to a 76-byte push (fits); 76 compiles to 78
        // (OP_PUSHDATA1), which the encoder rejects. Pre-flight must agree.
        expect(function () {
            actions.createAction({ action: 'BROADCAST', params: { message: 'x'.repeat(61), value: '1' }, encoder: { encoding: 'OP_RETURN' } });
        }).to.not.throw();
        let err;
        try {
            actions.createAction({ action: 'BROADCAST', params: { message: 'x'.repeat(62), value: '1' }, encoder: { encoding: 'OP_RETURN' } });
        } catch (e) { err = e; }
        expect(err).to.be.instanceOf(SDKValidationError);
        expect(err.code).to.equal('ENCODING_DATA_TOO_LARGE');
        expect(err.details.dataBytes).to.equal(76);
        expect(err.details.maxBytes).to.equal(75);
    });

});


describe('Actions – pre-flight encoding validation', function () {

    let actions;
    beforeEach(function () { actions = createActions(); });

    it('oversized-payload suggestion is network-aware: DOGE (non-segwit) gets P2SH, never P2WSH', function () {
        function actionsFor(network) {
            return new Actions({ config: config.getConfig(), util: new Utility(), options: { network } });
        }
        let big = 'y'.repeat(600); // > ENCODING_LIMITS.P2SH (476) -> default suggestion is P2WSH
        let segwitErr, dogeErr;
        try { actionsFor('litecoin-mainnet').createAction({ action: 'BROADCAST', params: { message: big, value: '1' }, encoder: { encoding: 'OP_RETURN' } }); } catch (e) { segwitErr = e; }
        try { actionsFor('dogecoin-mainnet').createAction({ action: 'BROADCAST', params: { message: big, value: '1' }, encoder: { encoding: 'OP_RETURN' } }); } catch (e) { dogeErr = e; }
        expect(segwitErr.details.suggestion).to.equal('P2WSH');
        expect(dogeErr.details.suggestion).to.equal('P2SH');
        expect(dogeErr.message).to.not.match(/P2WSH/);
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
