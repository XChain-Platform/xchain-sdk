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

// Group 4: Unicode and special characters

describe('Fuzz – Group 4: Unicode and special characters in MEMO', function() {

    function sendWithMemo(memo) {
        let actions = createActions();
        let threw = false;
        try {
            actions.createAction({
                action: 'send',
                params: { tick: 'TOK', amount: '100', destination: VALID_DEST, memo }
            });
        } catch (e) {
            threw = true;
            assertCleanError(e);
        }
        return threw;
    }

    it("emoji memo '🚀💰🔥' → must not crash", function() {
        sendWithMemo('🚀💰🔥');
    });

    it("Chinese characters '你好世界' → must not crash", function() {
        sendWithMemo('你好世界');
    });

    it("Arabic 'مرحبا' → must not crash", function() {
        sendWithMemo('مرحبا');
    });

    it("null bytes 'test\\x00data' → must not crash", function() {
        sendWithMemo('test\x00data');
    });

    it("control chars 'test\\x01\\x02\\x03' → must not crash", function() {
        sendWithMemo('test\x01\x02\x03');
    });

    it("mixed unicode 'Hello 世界 🌍' → must not crash", function() {
        sendWithMemo('Hello 世界 🌍');
    });

    it("whitespace-only memo '   ' → must not crash", function() {
        // Whitespace memo is not empty (length > 0), so it may pass or fail validation cleanly
        sendWithMemo('   ');
    });

    it("BOM character '\\uFEFFtest' → must not crash", function() {
        sendWithMemo('\uFEFFtest');
    });

});
