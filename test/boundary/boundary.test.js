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
 * XChain Platform SDK - Boundary Condition Tests
 *
 * Tests exact limit values for OP_RETURN encoding, field lengths,
 * numeric ranges, and format constraints.
 *
 ********************************************************************/

const { expect } = require('chai');
const config = require('../../src/config.js');
const Utility = require('../../src/utils/utility.js');
const Actions = require('../../src/actions/index.js');

function createActions() {
    let sdk = { config: config.getConfig(), util: new Utility() };
    return new Actions(sdk);
}

// 42-char segwit address used throughout SEND boundary tests
const DEST_42 = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';

// Build SEND params that produce an action string of exactly `targetBytes` bytes.
// Serialised form: "SEND|0|<TICK>|100|<DEST_42>"
//   "SEND|0|" = 7 bytes, "|100|" = 5 bytes, DEST_42 = 42 bytes → fixed = 54 bytes
// Therefore TICK length = targetBytes - 54.
function makeSendOfLength(targetBytes) {
    let tickLen = targetBytes - 54;
    if (tickLen < 1) throw new Error('targetBytes too small to build a valid SEND (minimum 55)');
    let tick = 'T'.repeat(tickLen);
    return { tick, amount: '100', destination: DEST_42 };
}


// OP_RETURN pre-flight encoding (6 tests)

describe('OP_RETURN pre-flight encoding boundary', function () {

    let actions;

    before(function () {
        actions = createActions();
    });

    // The ceiling used to be read as 76 bytes (80 - 4 magic), which ignored the
    // push prefix: a 76-byte payload compiles to an OP_PUSHDATA1 push of 78, and
    // 78 + 4 is over 80, so the encoder rejected on the wire what this pre-flight
    // had waved through. The pre-flight was moved onto the COMPILED push size,
    // putting the real ceiling at 75. 76 is now the first rejected length, which
    // is the boundary worth pinning here.
    it('rejects a SEND action string of exactly 76 bytes with OP_RETURN encoding', function () {
        let params = makeSendOfLength(76);
        expect(function () {
            actions.createAction({
                action: 'SEND',
                params,
                encoder: { encoding: 'OP_RETURN' }
            });
        }).to.throw().and.satisfy(function (err) {
            // 76 payload + 2-byte OP_PUSHDATA1 prefix + 4 magic = 82 > 80.
            return err.code === 'ENCODING_DATA_TOO_LARGE' && err.details.maxBytes === 75;
        });
    });

    it('rejects a SEND action string of 77 bytes with OP_RETURN encoding (ENCODING_DATA_TOO_LARGE)', function () {
        let params = makeSendOfLength(77);
        expect(function () {
            actions.createAction({
                action: 'SEND',
                params,
                encoder: { encoding: 'OP_RETURN' }
            });
        }).to.throw().and.satisfy(function (err) {
            return err.code === 'ENCODING_DATA_TOO_LARGE';
        });
    });

    it('accepts a SEND action string of exactly 75 bytes with OP_RETURN encoding', function () {
        let params = makeSendOfLength(75);
        let result = actions.createAction({
            action: 'SEND',
            params,
            encoder: { encoding: 'OP_RETURN' }
        });
        let byteLen = Buffer.byteLength(result.actionString, 'utf8');
        expect(byteLen).to.equal(75);
        expect(result.actionString).to.be.a('string');
    });

});

describe('OP_RETURN pre-flight encoding boundary', function () {

    let actions;

    before(function () {
        actions = createActions();
    });

    it('accepts a minimal SEND action string (smallest possible) with OP_RETURN encoding', function () {
        // TICK='T' → "SEND|0|T|100|<42-char-addr>" = 55 bytes, well within 76-byte limit
        let params = { tick: 'T', amount: '100', destination: DEST_42 };
        let result = actions.createAction({
            action: 'SEND',
            params,
            encoder: { encoding: 'OP_RETURN' }
        });
        let byteLen = Buffer.byteLength(result.actionString, 'utf8');
        expect(byteLen).to.equal(55);
        expect(result.actionString).to.be.a('string');
    });

    it('accepts a 1000-byte SEND action string with P2SH encoding (chunking:no limit check)', function () {
        let params = makeSendOfLength(1000);
        let result = actions.createAction({
            action: 'SEND',
            params,
            encoder: { encoding: 'P2SH' }
        });
        let byteLen = Buffer.byteLength(result.actionString, 'utf8');
        expect(byteLen).to.equal(1000);
        expect(result.actionString).to.be.a('string');
    });

    it('accepts a 1000-byte SEND action string with P2WSH encoding (chunking:no limit check)', function () {
        let params = makeSendOfLength(1000);
        let result = actions.createAction({
            action: 'SEND',
            params,
            encoder: { encoding: 'P2WSH' }
        });
        let byteLen = Buffer.byteLength(result.actionString, 'utf8');
        expect(byteLen).to.equal(1000);
        expect(result.actionString).to.be.a('string');
    });

});
