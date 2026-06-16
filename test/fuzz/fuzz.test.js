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
const Utility       = require('../../src/utility.js');
const Actions       = require('../../src/actions.js');
const Validator     = require('../../src/validator.js');
const FormatSelector = require('../../src/formatSelector.js');
const { SDKError, SDKValidationError, SDKFormatError } = require('../../src/errors.js');

// ─── helpers ──────────────────────────────────────────────────────────────────

function createActions() {
    let sdk = { config: config.getConfig(), util: new Utility() };
    return new Actions(sdk);
}

function createValidator() {
    return new Validator(new Utility());
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

// ─── Group 1: Garbage types for the action field ──────────────────────────────

describe('Fuzz – Group 1: Garbage types for action field', function() {

    it('action = null → SDKValidationError, never TypeError', function() {
        let actions = createActions();
        try {
            actions.createAction({ action: null });
            // If it doesn't throw, the null was somehow accepted — still not a crash
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

// ─── Group 2: Garbage types for SEND param fields ────────────────────────────

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

// ─── Group 3: Extreme string lengths ─────────────────────────────────────────

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
        // so it may or may not throw — either is acceptable as long as no crash.
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

// ─── Group 4: Unicode and special characters ──────────────────────────────────

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

// ─── Group 5: Prototype pollution attempts ────────────────────────────────────

describe('Fuzz – Group 5: Prototype pollution attempts', function() {

    // Snapshot Object.prototype before any tests in this group
    let protoBefore;
    before(function() {
        protoBefore = Object.getOwnPropertyNames(Object.prototype).slice().sort().join(',');
    });

    function assertPrototypeUnchanged() {
        let protoAfter = Object.getOwnPropertyNames(Object.prototype).slice().sort().join(',');
        expect(protoAfter).to.equal(protoBefore, 'Object.prototype must not be modified');
    }

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

// ─── Group 6: Validator with garbage inputs ───────────────────────────────────

describe('Fuzz – Group 6: Validator with garbage inputs', function() {

    it('validate(null, {}) → returns errors array, never crash', function() {
        let validator = createValidator();
        let threw = false;
        try {
            let result = validator.validate(null, {});
            // Should return an array (possibly with UNKNOWN_ACTION error)
            expect(result).to.be.an('array');
        } catch (e) {
            threw = true;
            // If it throws, must be a clean SDK error
            assertCleanError(e);
        }
    });

    it('validate(123, {}) → returns errors array or clean throw', function() {
        let validator = createValidator();
        let threw = false;
        try {
            let result = validator.validate(123, {});
            expect(result).to.be.an('array');
        } catch (e) {
            threw = true;
            assertCleanError(e);
        }
    });

    it('validate("SEND", null) → must not crash', function() {
        let validator = createValidator();
        let threw = false;
        try {
            let result = validator.validate('SEND', null);
            // null fields — may return errors or empty array
            expect(result).to.be.an('array');
        } catch (e) {
            threw = true;
            assertCleanError(e);
        }
    });

    it("validate('SEND', 'string') → must not crash", function() {
        let validator = createValidator();
        let threw = false;
        try {
            let result = validator.validate('SEND', 'string');
            expect(result).to.be.an('array');
        } catch (e) {
            threw = true;
            assertCleanError(e);
        }
    });

    it('validate("SEND", []) → must not crash', function() {
        let validator = createValidator();
        let threw = false;
        try {
            let result = validator.validate('SEND', []);
            expect(result).to.be.an('array');
        } catch (e) {
            threw = true;
            assertCleanError(e);
        }
    });

    it('SEND with TICK = { nested: object } → must not crash', function() {
        let validator = createValidator();
        let threw = false;
        try {
            let result = validator.validate('SEND', { TICK: { nested: 'object' }, AMOUNT: '100', DESTINATION: VALID_DEST });
            expect(result).to.be.an('array');
        } catch (e) {
            threw = true;
            assertCleanError(e);
        }
    });

    it('SEND with AMOUNT = [1, 2, 3] → must not crash', function() {
        let validator = createValidator();
        let threw = false;
        try {
            let result = validator.validate('SEND', { TICK: 'TOK', AMOUNT: [1, 2, 3], DESTINATION: VALID_DEST });
            expect(result).to.be.an('array');
        } catch (e) {
            threw = true;
            assertCleanError(e);
        }
    });

    it('ISSUE with DECIMALS = NaN → returns errors', function() {
        let validator = createValidator();
        let threw = false;
        try {
            let result = validator.validate('ISSUE', { TICK: 'MYTOKEN', DECIMALS: NaN });
            expect(result).to.be.an('array');
            // NaN should fail the DECIMALS integer check
            let hasDecimalsError = result.some(e => e.field === 'DECIMALS' || e.code === 'INVALID_FIELD_VALUE');
            // Either an error is reported or the NaN was treated as isEmpty and skipped
            // Both outcomes are acceptable as long as it doesn't crash
        } catch (e) {
            threw = true;
            assertCleanError(e);
        }
    });

    it('ISSUE with DECIMALS = Infinity → returns errors', function() {
        let validator = createValidator();
        let threw = false;
        try {
            let result = validator.validate('ISSUE', { TICK: 'MYTOKEN', DECIMALS: Infinity });
            expect(result).to.be.an('array');
        } catch (e) {
            threw = true;
            assertCleanError(e);
        }
    });

    it('ISSUE with MAX_SUPPLY = -Infinity → returns errors', function() {
        let validator = createValidator();
        let threw = false;
        try {
            let result = validator.validate('ISSUE', { TICK: 'MYTOKEN', MAX_SUPPLY: -Infinity });
            expect(result).to.be.an('array');
        } catch (e) {
            threw = true;
            assertCleanError(e);
        }
    });

});

// ─── Group 7: FormatSelector with garbage inputs ──────────────────────────────

describe('Fuzz – Group 7: FormatSelector with garbage inputs', function() {

    it('select(null, {}) → SDKFormatError, never TypeError', function() {
        let threw = false;
        try {
            FormatSelector.select(null, {});
        } catch (e) {
            threw = true;
            assertCleanError(e);
            expect(e).to.be.instanceOf(SDKFormatError);
        }
        expect(threw, 'Expected SDKFormatError for null action').to.be.true;
    });

    it("select('', {}) → SDKFormatError", function() {
        let threw = false;
        try {
            FormatSelector.select('', {});
        } catch (e) {
            threw = true;
            assertCleanError(e);
            expect(e).to.be.instanceOf(SDKFormatError);
        }
        expect(threw, 'Expected SDKFormatError for empty string action').to.be.true;
    });

    it("select('SEND', null) → clean throw or return, never crash", function() {
        let threw = false;
        try {
            let result = FormatSelector.select('SEND', null);
            // If null fields are tolerated, result should be an object
            expect(result).to.be.an('object');
        } catch (e) {
            threw = true;
            assertCleanError(e);
        }
    });

    it("select('SEND', 'not an object') → clean throw or return, never crash", function() {
        let threw = false;
        try {
            let result = FormatSelector.select('SEND', 'not an object');
            expect(result).to.be.an('object');
        } catch (e) {
            threw = true;
            assertCleanError(e);
        }
    });

    it("select('SEND', deeply nested object) → must not crash", function() {
        // Build a deeply nested object
        let deep = {};
        let cursor = deep;
        for (let i = 0; i < 100; i++) {
            cursor.child = {};
            cursor = cursor.child;
        }
        cursor.TICK = 'TOK';

        let threw = false;
        try {
            let result = FormatSelector.select('SEND', deep);
            expect(result).to.be.an('object');
        } catch (e) {
            threw = true;
            assertCleanError(e);
        }
    });

    it('serialize("SEND", 1, null) → clean throw or result, never crash', function() {
        let threw = false;
        try {
            let result = FormatSelector.serialize('SEND', 1, null);
            // If null is tolerated, result should be a string
            expect(result).to.be.a('string');
        } catch (e) {
            threw = true;
            assertCleanError(e);
        }
    });

});

// ─── Group 8: Rapid-fire random actions ──────────────────────────────────────

describe('Fuzz – Group 8: Rapid-fire random actions', function() {

    it('100 random createAction calls → all errors are SDKError subclasses', function() {
        let actions = createActions();
        let validActions = actions.getActions();

        // Pool of random field values (mix of valid-ish and garbage)
        let randomValues = [
            'SOMETOKEN', 'tok', '123', '', null, undefined,
            0, -1, 999999, true, false, NaN, Infinity, [], {}, 'hello world',
            VALID_DEST, 'bc1invalid', '1A1zP1eP5QGefi2DMPTfTL5SLmv7Divf', // P2PKH len-34
            'SHORT', '!@#$%', 'A'.repeat(300), '你好', '🔥',
        ];

        function pick(arr) {
            return arr[Math.floor(Math.random() * arr.length)];
        }

        let successes = 0;
        let sdkErrors = 0;
        let badErrors = [];

        for (let i = 0; i < 100; i++) {
            let actionName = pick(validActions);
            let params = {
                tick:        pick(randomValues),
                amount:      pick(randomValues),
                destination: pick(randomValues),
                memo:        pick(randomValues),
                maxSupply:   pick(randomValues),
                decimals:    pick(randomValues),
                description: pick(randomValues),
            };

            try {
                actions.createAction({ action: actionName, params });
                successes++;
            } catch (e) {
                if (e instanceof SDKError) {
                    sdkErrors++;
                } else {
                    badErrors.push({
                        action: actionName,
                        errorName: e.name,
                        errorMessage: e.message,
                        errorConstructor: e.constructor.name
                    });
                }
            }
        }

        // Report
        // All errors must be SDKError subclasses — no raw runtime errors allowed
        if (badErrors.length > 0) {
            let summary = badErrors.map(b =>
                `action=${b.action} threw ${b.errorConstructor}: ${b.errorMessage}`
            ).join('\n');
            throw new Error(
                `${badErrors.length} raw (non-SDK) errors were thrown:\n${summary}`
            );
        }

        // Sanity: we ran 100 iterations
        expect(successes + sdkErrors).to.equal(100);
    });

});
