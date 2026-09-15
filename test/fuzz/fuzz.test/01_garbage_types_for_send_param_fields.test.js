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

// Group 2: Garbage types for SEND param fields

describe('Fuzz – Group 2: Garbage types for SEND param fields', function() {

    const garbageValues = [
        { label: 'null',        value: null },
        { label: 'undefined',   value: undefined },
        { label: '0',           value: 0 },
        { label: 'false',       value: false },
        { label: 'NaN',         value: NaN },
        { label: 'Infinity',    value: Infinity },
        { label: '-Infinity',   value: -Infinity },
        { label: '[]',          value: [] },
        { label: '{}',          value: {} },
        { label: 'function(){}',value: function(){} },
        { label: "Symbol('x')", value: Symbol('x') },
        { label: "Buffer.from('test')", value: Buffer.from('test') },
    ];

    for (let { label, value } of garbageValues) {
        it(`TICK = ${label} → succeed or SDKValidationError, never crash`, function() {
            let actions = createActions();
            let threw = false;
            try {
                actions.createAction({
                    action: 'send',
                    params: { tick: value, amount: '100', destination: VALID_DEST }
                });
            } catch (e) {
                threw = true;
                assertCleanError(e);
            }
            // Test passes whether it threw a clean error or succeeded
        });
    }

});

describe('Fuzz – Group 2: Garbage types for SEND param fields', function() {

    it('AMOUNT = {} → succeed or SDKValidationError', function() {
        let actions = createActions();
        let threw = false;
        try {
            actions.createAction({
                action: 'send',
                params: { tick: 'MYTOKEN', amount: {}, destination: VALID_DEST }
            });
        } catch (e) {
            threw = true;
            assertCleanError(e);
        }
    });

    it('DESTINATION = [] → succeed or SDKValidationError', function() {
        let actions = createActions();
        let threw = false;
        try {
            actions.createAction({
                action: 'send',
                params: { tick: 'MYTOKEN', amount: '100', destination: [] }
            });
        } catch (e) {
            threw = true;
            assertCleanError(e);
        }
    });

});
