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
 * XChain Platform SDK - Fuzz Tests
 *
 * Core principle: NO test should cause an unhandled exception.
 * Every test must either succeed or throw a clean SDKError subclass.
 * A raw TypeError, RangeError, etc. is a bug.
 *
 ********************************************************************/

const { expect }    = require('chai');
const config        = require('../../../src/config.js');
const Utility       = require('../../../src/utils/utility.js');
const Actions       = require('../../../src/actions/index.js');
const { SDKValidationError } = require('../../../src/utils/errors.js');

function createActions() {
    let sdk = { config: config.getConfig(), util: new Utility() };
    return new Actions(sdk);
}

// A real-looking segwit address (42 chars – passes the loose isCryptoAddress check)
const VALID_DEST = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';

// Raw error types that must NEVER escape from SDK boundaries
const RAW_ERROR_CONSTRUCTORS = [TypeError, RangeError, SyntaxError, URIError, EvalError];

function assertCleanError(e) {
    // Must be an Error instance
    expect(e, 'thrown value must be an Error').to.be.instanceOf(Error);
    // Must NOT be a raw JS runtime error
    for (let RawErr of RAW_ERROR_CONSTRUCTORS) {
        expect(e, `must not be a raw ${RawErr.name}`).to.not.be.instanceOf(RawErr);
    }
    // Name must start with "SDK"
    expect(e.name, 'error name must start with SDK').to.match(/^SDK/);
}

// Group 3: Extreme string lengths

describe('Fuzz – Group 3: Extreme string lengths', function() {

    it('TICK with 10,000 character string → must not crash', function() {
        let actions = createActions();
        let longTick = 'A'.repeat(10000);
        let threw = false;
        try {
            actions.createAction({
                action: 'send',
                params: { tick: longTick, amount: '100', destination: VALID_DEST }
            });
        } catch (e) {
            threw = true;
            assertCleanError(e);
        }
        // A 10k-char TICK passes the non-ISSUE TICK path (only ^-prefix check applies),
        // so it may or may not throw; either is acceptable as long as no crash.
    });

    it('MEMO with 1MB string → must not crash', function() {
        let actions = createActions();
        let bigMemo = 'x'.repeat(1048576);
        let threw = false;
        try {
            actions.createAction({
                action: 'send',
                params: { tick: 'TOK', amount: '100', destination: VALID_DEST, memo: bigMemo }
            });
        } catch (e) {
            threw = true;
            assertCleanError(e);
        }
    });

});

describe('Fuzz – Group 3: Extreme string lengths', function() {

    it('DESCRIPTION with 100,000 character string → should throw validation error', function() {
        let actions = createActions();
        let bigDesc = 'D'.repeat(100000);
        let threw = false;
        try {
            actions.createAction({
                action: 'issue',
                params: { tick: 'TOKEN', description: bigDesc }
            });
        } catch (e) {
            threw = true;
            assertCleanError(e);
            // DESCRIPTION has a 250-char cap enforced by validator
            expect(e).to.be.instanceOf(SDKValidationError);
        }
        expect(threw, 'Expected a validation error for 100k-char DESCRIPTION').to.be.true;
    });

    it('PLAINTEXT_MESSAGE with 2MB string → should throw validation error', function() {
        let actions = createActions();
        let bigMsg = 'M'.repeat(2097152);
        let threw = false;
        try {
            actions.createAction({
                action: 'message',
                params: { destination: VALID_DEST, plaintextMessage: bigMsg }
            });
        } catch (e) {
            threw = true;
            assertCleanError(e);
            // 2MB exceeds the 1MB MAX_MESSAGE_LENGTH limit
            expect(e).to.be.instanceOf(SDKValidationError);
        }
        expect(threw, 'Expected a validation error for 2MB PLAINTEXT_MESSAGE').to.be.true;
    });

    it('action name as 10,000 character string → should throw', function() {
        let actions = createActions();
        let longAction = 'A'.repeat(10000);
        let threw = false;
        try {
            actions.createAction({ action: longAction });
        } catch (e) {
            threw = true;
            assertCleanError(e);
            expect(e).to.be.instanceOf(SDKValidationError);
        }
        expect(threw, 'Expected a validation error for 10k-char action name').to.be.true;
    });

});
