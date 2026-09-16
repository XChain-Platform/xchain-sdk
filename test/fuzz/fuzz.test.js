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
const config        = require('../../src/config.js');
const Utility       = require('../../src/utils/utility.js');
const Actions       = require('../../src/actions/index.js');
const { SDKValidationError } = require('../../src/utils/errors.js');

// helpers

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

// Group 1: Garbage types for the action field

describe('Fuzz – Group 1: Garbage types for action field', function() {

    it('action = null → SDKValidationError, never TypeError', function() {
        let actions = createActions();
        try {
            actions.createAction({ action: null });
            // If it doesn't throw, the null was somehow accepted; still not a crash
        } catch (e) {
            assertCleanError(e);
            expect(e).to.be.instanceOf(SDKValidationError);
        }
    });

    it('action = undefined → SDKValidationError', function() {
        let actions = createActions();
        try {
            actions.createAction({ action: undefined });
        } catch (e) {
            assertCleanError(e);
            expect(e).to.be.instanceOf(SDKValidationError);
        }
    });

    it('action = 123 (number) → SDKValidationError', function() {
        let actions = createActions();
        try {
            actions.createAction({ action: 123 });
        } catch (e) {
            assertCleanError(e);
            expect(e).to.be.instanceOf(SDKValidationError);
        }
    });

    it('action = true (boolean) → SDKValidationError', function() {
        let actions = createActions();
        try {
            actions.createAction({ action: true });
        } catch (e) {
            assertCleanError(e);
            expect(e).to.be.instanceOf(SDKValidationError);
        }
    });

});

describe('Fuzz – Group 1: Garbage types for action field', function() {

    it('action = [] (empty array) → SDKValidationError', function() {
        let actions = createActions();
        try {
            actions.createAction({ action: [] });
        } catch (e) {
            assertCleanError(e);
            expect(e).to.be.instanceOf(SDKValidationError);
        }
    });

    it('action = {} (empty object) → SDKValidationError', function() {
        let actions = createActions();
        try {
            actions.createAction({ action: {} });
        } catch (e) {
            assertCleanError(e);
            expect(e).to.be.instanceOf(SDKValidationError);
        }
    });

    it("action = '' (empty string) → SDKValidationError", function() {
        let actions = createActions();
        try {
            actions.createAction({ action: '' });
        } catch (e) {
            assertCleanError(e);
            expect(e).to.be.instanceOf(SDKValidationError);
        }
    });

    it('action = Symbol() → SDKValidationError, never TypeError', function() {
        let actions = createActions();
        try {
            actions.createAction({ action: Symbol('fuzz') });
        } catch (e) {
            assertCleanError(e);
            expect(e).to.be.instanceOf(SDKValidationError);
        }
    });

});
