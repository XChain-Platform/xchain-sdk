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

// Group 5: Prototype pollution attempts

// Snapshot Object.prototype before any tests in this group
let protoBefore;

function capturePrototype() {
    protoBefore = Object.getOwnPropertyNames(Object.prototype).slice().sort().join(',');
}

function assertPrototypeUnchanged() {
    let protoAfter = Object.getOwnPropertyNames(Object.prototype).slice().sort().join(',');
    expect(protoAfter).to.equal(protoBefore, 'Object.prototype must not be modified');
}

describe('Fuzz – Group 5: Prototype pollution attempts', function() {

    before(capturePrototype);

    it('__proto__ key in params → must not pollute Object.prototype', function() {
        let actions = createActions();
        try {
            actions.createAction({
                action: 'send',
                params: { __proto__: 'polluted', tick: 'T', amount: '1', destination: VALID_DEST }
            });
        } catch (e) {
            assertCleanError(e);
        }
        assertPrototypeUnchanged();
        // Also verify the value didn't leak onto Object.prototype
        expect(({}).__proto__).to.not.equal('polluted');
    });

    it('constructor key in params → must not crash', function() {
        let actions = createActions();
        try {
            actions.createAction({
                action: 'send',
                params: { constructor: 'attack', tick: 'T', amount: '1', destination: VALID_DEST }
            });
        } catch (e) {
            assertCleanError(e);
        }
        assertPrototypeUnchanged();
    });

});

describe('Fuzz – Group 5: Prototype pollution attempts', function() {

    before(capturePrototype);

    it('toString key in params → must not crash', function() {
        let actions = createActions();
        try {
            actions.createAction({
                action: 'send',
                params: { toString: 'overwrite', tick: 'T', amount: '1', destination: VALID_DEST }
            });
        } catch (e) {
            assertCleanError(e);
        }
        assertPrototypeUnchanged();
    });

    it('hasOwnProperty key in params → must not crash', function() {
        let actions = createActions();
        try {
            actions.createAction({
                action: 'send',
                params: { hasOwnProperty: 'overwrite', tick: 'T', amount: '1', destination: VALID_DEST }
            });
        } catch (e) {
            assertCleanError(e);
        }
        assertPrototypeUnchanged();
    });

});
