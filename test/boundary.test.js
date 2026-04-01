/*********************************************************************
 *
 * XChain Platform SDK - Boundary Condition Tests
 *
 * Tests exact limit values for OP_RETURN encoding, field lengths,
 * numeric ranges, and format constraints.
 *
 ********************************************************************/

const { expect } = require('chai');
const config = require('../src/config.js');
const Utility = require('../src/utility.js');
const Actions = require('../src/actions.js');
const Validator = require('../src/validator.js');
const FormatSelector = require('../src/formatSelector.js');

function createActions() {
    let sdk = { config: config.getConfig(), util: new Utility() };
    return new Actions(sdk);
}

function createValidator() {
    return new Validator(new Utility());
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


// ---------------------------------------------------------------------------
// Section 1 — OP_RETURN pre-flight encoding (6 tests)
// ---------------------------------------------------------------------------

describe('OP_RETURN pre-flight encoding boundary', function () {

    let actions;

    before(function () {
        actions = createActions();
    });

    it('accepts a SEND action string of exactly 76 bytes with OP_RETURN encoding', function () {
        let params = makeSendOfLength(76);
        let result = actions.createAction({
            action: 'SEND',
            params,
            encoder: { encoding: 'OP_RETURN' }
        });
        let byteLen = Buffer.byteLength(result.actionString, 'utf8');
        expect(byteLen).to.equal(76, 'action string must be exactly 76 bytes');
        // No throw means the test passes — just confirm the result is a string
        expect(result.actionString).to.be.a('string');
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

    it('accepts a 1000-byte SEND action string with P2SH encoding (chunking — no limit check)', function () {
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

    it('accepts a 1000-byte SEND action string with P2WSH encoding (chunking — no limit check)', function () {
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


// ---------------------------------------------------------------------------
// Section 2 — TICK name length boundary (4 tests)
// ---------------------------------------------------------------------------

describe('TICK name length boundary', function () {

    let actions;

    before(function () {
        actions = createActions();
    });

    it('accepts a TICK name of exactly 1 character on ISSUE', function () {
        let result = actions.createAction({ action: 'ISSUE', params: { tick: 'A' } });
        expect(result.actionString).to.include('A');
    });

    it('accepts a TICK name of exactly 250 characters on ISSUE', function () {
        let tick = 'A'.repeat(250);
        let result = actions.createAction({ action: 'ISSUE', params: { tick } });
        expect(result.actionString).to.include(tick);
    });

    it('rejects a TICK name of exactly 251 characters on ISSUE (INVALID_TICK_NAME)', function () {
        let tick = 'A'.repeat(251);
        expect(function () {
            actions.createAction({ action: 'ISSUE', params: { tick } });
        }).to.throw().and.satisfy(function (err) {
            return err.code === 'INVALID_TICK_NAME';
        });
    });

    it('rejects an empty TICK name on ISSUE (MISSING_REQUIRED_FIELD)', function () {
        expect(function () {
            actions.createAction({ action: 'ISSUE', params: { tick: '' } });
        }).to.throw().and.satisfy(function (err) {
            return err.code === 'MISSING_REQUIRED_FIELD';
        });
    });

});


// ---------------------------------------------------------------------------
// Section 3 — DECIMALS boundary (4 tests)
// ---------------------------------------------------------------------------

describe('DECIMALS boundary', function () {

    let validator;

    before(function () {
        validator = createValidator();
    });

    it('accepts DECIMALS = 0', function () {
        let errors = validator.validate('ISSUE', { TICK: 'TEST', DECIMALS: 0 });
        let decErrors = errors.filter(function (e) { return e.details && e.details.field === 'DECIMALS'; });
        expect(decErrors).to.have.length(0);
    });

    it('accepts DECIMALS = 18 (maximum valid)', function () {
        let errors = validator.validate('ISSUE', { TICK: 'TEST', DECIMALS: 18 });
        let decErrors = errors.filter(function (e) { return e.details && e.details.field === 'DECIMALS'; });
        expect(decErrors).to.have.length(0);
    });

    it('rejects DECIMALS = 19 (one above maximum)', function () {
        let errors = validator.validate('ISSUE', { TICK: 'TEST', DECIMALS: 19 });
        let decErrors = errors.filter(function (e) { return e.details && e.details.field === 'DECIMALS'; });
        expect(decErrors).to.have.length.greaterThan(0);
        expect(decErrors[0].code).to.equal('INVALID_FIELD_VALUE');
    });

    it('rejects DECIMALS = -1 (below minimum)', function () {
        let errors = validator.validate('ISSUE', { TICK: 'TEST', DECIMALS: -1 });
        let decErrors = errors.filter(function (e) { return e.details && e.details.field === 'DECIMALS'; });
        expect(decErrors).to.have.length.greaterThan(0);
        expect(decErrors[0].code).to.equal('INVALID_FIELD_VALUE');
    });

});


// ---------------------------------------------------------------------------
// Section 4 — MAX_SUPPLY boundary (4 tests)
// ---------------------------------------------------------------------------

describe('MAX_SUPPLY boundary', function () {

    let validator;

    before(function () {
        validator = createValidator();
    });

    it('accepts MAX_SUPPLY = 1000000000000000000000 (exactly 1 sextillion)', function () {
        let errors = validator.validate('ISSUE', { TICK: 'TEST', MAX_SUPPLY: '1000000000000000000000' });
        let supErrors = errors.filter(function (e) { return e.details && e.details.field === 'MAX_SUPPLY'; });
        expect(supErrors).to.have.length(0);
    });

    it('rejects MAX_SUPPLY = 1000000000000000000001 (1 sextillion + 1)', function () {
        let errors = validator.validate('ISSUE', { TICK: 'TEST', MAX_SUPPLY: '1000000000000000000001' });
        let supErrors = errors.filter(function (e) { return e.details && e.details.field === 'MAX_SUPPLY'; });
        expect(supErrors).to.have.length.greaterThan(0);
        expect(supErrors[0].code).to.equal('INVALID_FIELD_VALUE');
    });

    it('accepts MAX_SUPPLY = 999999999999999999999 (one below ceiling)', function () {
        let errors = validator.validate('ISSUE', { TICK: 'TEST', MAX_SUPPLY: '999999999999999999999' });
        let supErrors = errors.filter(function (e) { return e.details && e.details.field === 'MAX_SUPPLY'; });
        expect(supErrors).to.have.length(0);
    });

    it('accepts MAX_SUPPLY = 0', function () {
        let errors = validator.validate('ISSUE', { TICK: 'TEST', MAX_SUPPLY: '0' });
        let supErrors = errors.filter(function (e) { return e.details && e.details.field === 'MAX_SUPPLY'; });
        expect(supErrors).to.have.length(0);
    });

});


// ---------------------------------------------------------------------------
// Section 5 — DESCRIPTION length boundary (3 tests)
// ---------------------------------------------------------------------------

describe('DESCRIPTION length boundary', function () {

    let validator;

    before(function () {
        validator = createValidator();
    });

    it('accepts DESCRIPTION of exactly 250 characters (maximum valid)', function () {
        let description = 'D'.repeat(250);
        let errors = validator.validate('ISSUE', { TICK: 'TEST', DESCRIPTION: description });
        let descErrors = errors.filter(function (e) { return e.details && e.details.field === 'DESCRIPTION'; });
        expect(descErrors).to.have.length(0);
    });

    it('rejects DESCRIPTION of exactly 251 characters (one above maximum)', function () {
        let description = 'D'.repeat(251);
        let errors = validator.validate('ISSUE', { TICK: 'TEST', DESCRIPTION: description });
        let descErrors = errors.filter(function (e) { return e.details && e.details.field === 'DESCRIPTION'; });
        expect(descErrors).to.have.length.greaterThan(0);
        expect(descErrors[0].code).to.equal('INVALID_FIELD_VALUE');
    });

    it('accepts DESCRIPTION of exactly 249 characters (one below maximum)', function () {
        let description = 'D'.repeat(249);
        let errors = validator.validate('ISSUE', { TICK: 'TEST', DESCRIPTION: description });
        let descErrors = errors.filter(function (e) { return e.details && e.details.field === 'DESCRIPTION'; });
        expect(descErrors).to.have.length(0);
    });

});


// ---------------------------------------------------------------------------
// Section 6 — MESSAGE length boundary (3 tests)
// ---------------------------------------------------------------------------

describe('MESSAGE (PLAINTEXT_MESSAGE) length boundary', function () {

    let validator;
    // 1 MiB = 1,048,576 characters
    const MAX_LEN = 1048576;

    before(function () {
        validator = createValidator();
    });

    it('accepts PLAINTEXT_MESSAGE of exactly 1,048,576 characters (1 MiB limit)', function () {
        let msg = 'M'.repeat(MAX_LEN);
        let errors = validator.validate('MESSAGE', { DESTINATION: DEST_42, PLAINTEXT_MESSAGE: msg });
        let msgErrors = errors.filter(function (e) { return e.details && e.details.field === 'PLAINTEXT_MESSAGE'; });
        expect(msgErrors).to.have.length(0);
    });

    it('rejects PLAINTEXT_MESSAGE of exactly 1,048,577 characters (one above limit)', function () {
        let msg = 'M'.repeat(MAX_LEN + 1);
        let errors = validator.validate('MESSAGE', { DESTINATION: DEST_42, PLAINTEXT_MESSAGE: msg });
        let msgErrors = errors.filter(function (e) { return e.details && e.details.field === 'PLAINTEXT_MESSAGE'; });
        expect(msgErrors).to.have.length.greaterThan(0);
        expect(msgErrors[0].code).to.equal('INVALID_FIELD_VALUE');
    });

    it('accepts PLAINTEXT_MESSAGE of exactly 1,048,575 characters (one below limit)', function () {
        let msg = 'M'.repeat(MAX_LEN - 1);
        let errors = validator.validate('MESSAGE', { DESTINATION: DEST_42, PLAINTEXT_MESSAGE: msg });
        let msgErrors = errors.filter(function (e) { return e.details && e.details.field === 'PLAINTEXT_MESSAGE'; });
        expect(msgErrors).to.have.length(0);
    });

});


// ---------------------------------------------------------------------------
// Section 7 — FIAT_AMOUNT format boundary (5 tests)
// ---------------------------------------------------------------------------

describe('FIAT_AMOUNT format boundary', function () {

    let validator;

    before(function () {
        validator = createValidator();
    });

    // Helper: run validate with a DISPENSER skeleton so FIAT_AMOUNT is evaluated
    function fiatErrors(amount) {
        let errors = validator.validate('DISPENSER', {
            GIVE_TICK: 'BTC',
            GIVE_AMOUNT: 1,
            GET_TICK: 'LTC',
            GET_AMOUNT: 1,
            FIAT_CODE: 'USD',
            FIAT_AMOUNT: amount
        });
        return errors.filter(function (e) { return e.details && e.details.field === 'FIAT_AMOUNT'; });
    }

    it("accepts FIAT_AMOUNT '0.00' (zero with two decimal places)", function () {
        expect(fiatErrors('0.00')).to.have.length(0);
    });

    it("accepts FIAT_AMOUNT '999999.99' (large valid amount)", function () {
        expect(fiatErrors('999999.99')).to.have.length(0);
    });

    it("rejects FIAT_AMOUNT '1.0' (only one decimal place)", function () {
        let errs = fiatErrors('1.0');
        expect(errs).to.have.length.greaterThan(0);
        expect(errs[0].code).to.equal('INVALID_FIELD_VALUE');
    });

    it("rejects FIAT_AMOUNT '1' (no decimal places)", function () {
        let errs = fiatErrors('1');
        expect(errs).to.have.length.greaterThan(0);
        expect(errs[0].code).to.equal('INVALID_FIELD_VALUE');
    });

    it("rejects FIAT_AMOUNT '1.000' (three decimal places)", function () {
        let errs = fiatErrors('1.000');
        expect(errs).to.have.length.greaterThan(0);
        expect(errs[0].code).to.equal('INVALID_FIELD_VALUE');
    });

});


// ---------------------------------------------------------------------------
// Section 8 — Address length boundary (4 tests)
// ---------------------------------------------------------------------------

describe('Address (DESTINATION) length boundary', function () {

    let validator;

    before(function () {
        validator = createValidator();
    });

    // Helper: validate a SEND with the given destination value
    function destErrors(destination) {
        let errors = validator.validate('SEND', {
            TICK: 'TEST',
            AMOUNT: 100,
            DESTINATION: destination
        });
        return errors.filter(function (e) { return e.details && e.details.field === 'DESTINATION'; });
    }

    it('accepts a 26-character DESTINATION (minimum P2PKH length)', function () {
        // 26 chars = lower bound of the 26-35 P2PKH range
        let addr = '1'.repeat(26);
        expect(destErrors(addr)).to.have.length(0);
    });

    it('accepts a 35-character DESTINATION (maximum P2PKH length)', function () {
        let addr = '1'.repeat(35);
        expect(destErrors(addr)).to.have.length(0);
    });

    it('accepts a 42-character DESTINATION (segwit)', function () {
        expect(destErrors(DEST_42)).to.have.length(0);
    });

    it('rejects a 25-character DESTINATION (one below minimum)', function () {
        let addr = '1'.repeat(25);
        let errs = destErrors(addr);
        expect(errs).to.have.length.greaterThan(0);
        expect(errs[0].code).to.equal('INVALID_FIELD_VALUE');
    });

});


// ---------------------------------------------------------------------------
// Section 9 — Lock field boundary (3 tests)
// ---------------------------------------------------------------------------

describe('Lock field boundary', function () {

    let validator;

    before(function () {
        validator = createValidator();
    });

    // Helper: validate an ISSUE with a specific LOCK_MAX_SUPPLY value
    function lockErrors(value) {
        let errors = validator.validate('ISSUE', { TICK: 'TEST', LOCK_MAX_SUPPLY: value });
        return errors.filter(function (e) { return e.details && e.details.field === 'LOCK_MAX_SUPPLY'; });
    }

    it('accepts LOCK_MAX_SUPPLY = 0 (unlocked)', function () {
        expect(lockErrors(0)).to.have.length(0);
    });

    it('accepts LOCK_MAX_SUPPLY = 1 (locked)', function () {
        expect(lockErrors(1)).to.have.length(0);
    });

    it('rejects LOCK_MAX_SUPPLY = 2 (smallest invalid value)', function () {
        let errs = lockErrors(2);
        expect(errs).to.have.length.greaterThan(0);
        expect(errs[0].code).to.equal('INVALID_FIELD_VALUE');
    });

});
