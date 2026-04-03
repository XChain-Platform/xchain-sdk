/*********************************************************************
 *
 * XChain Platform SDK - VM Integration Tests
 *
 * Comprehensive tests for VM action support: DEPLOY, EXECUTE, DEPOSIT,
 * WITHDRAW actions, contract utilities, contract client, format
 * selection, validation, batch integration, and explorer methods.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const config     = require('../src/config.js');
const Utility    = require('../src/utility.js');
const Actions    = require('../src/actions.js');
const FormatSelector   = require('../src/formatSelector.js');
const Validator        = require('../src/validator.js');
const ContractUtils    = require('../src/contracts.js');
const ContractClient   = require('../src/contractClient.js');
const { SDKValidationError, SDKContractError } = require('../src/errors.js');

const ADDR = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';

// Factory: create a fresh Actions instance
function createActions() {
    let sdk = { config: config.getConfig(), util: new Utility() };
    return new Actions(sdk);
}

// Simple contract source for testing
const SIMPLE_CONTRACT = `
module.exports = {
    greet: function(xchain) {
        return 'hello ' + xchain.getInputParam(0);
    }
};
`;

const LARGE_CONTRACT = 'x'.repeat(65537); // exceeds 64KB


// ===========================================================================
// Section 1: DEPLOY action
// ===========================================================================

describe('VM Actions – DEPLOY', function () {

    let actions;
    beforeEach(function () { actions = createActions(); });

    it('creates DEPLOY with raw code (auto hex-encoding)', function () {
        let result = actions.createAction({
            action: 'DEPLOY',
            params: { code: 'module.exports = {}', gasLimit: 100000 }
        });
        expect(result.action).to.equal('DEPLOY');
        expect(result.version).to.equal(0);
        expect(result.actionString).to.match(/^DEPLOY\|0\|/);
        expect(result.fields.CODE_ENCODING).to.equal(
            Buffer.from('module.exports = {}', 'utf8').toString('hex')
        );
        expect(result.fields.GAS_LIMIT).to.equal(100000);
        expect(result.fields.CODE).to.be.undefined;
    });

    it('creates DEPLOY with pre-encoded hex', function () {
        let hex = Buffer.from('var x = 1;', 'utf8').toString('hex');
        let result = actions.createAction({
            action: 'DEPLOY',
            params: { codeEncoding: hex, gasLimit: 50000 }
        });
        expect(result.fields.CODE_ENCODING).to.equal(hex);
    });

    it('creates DEPLOY with constructor params', function () {
        let result = actions.createAction({
            action: 'DEPLOY',
            params: {
                code: 'module.exports = function(){}',
                gasLimit: 100000,
                constructorParams: ['arg1', 'arg2', 'arg3']
            }
        });
        expect(result.actionString).to.include('arg1');
        expect(result.actionString).to.include('arg2');
        expect(result.actionString).to.include('arg3');
        // Verify they are pipe-delimited after the gas limit
        let parts = result.actionString.split('|');
        expect(parts[0]).to.equal('DEPLOY');
        expect(parts[1]).to.equal('0');
        // parts[2] = hex code, parts[3] = gas limit, parts[4+] = constructor params
        expect(parts[parts.length - 3]).to.equal('arg1');
        expect(parts[parts.length - 2]).to.equal('arg2');
        expect(parts[parts.length - 1]).to.equal('arg3');
    });

    it('rejects DEPLOY without CODE_ENCODING', function () {
        expect(() => actions.createAction({
            action: 'DEPLOY',
            params: { gasLimit: 100000 }
        })).to.throw(SDKValidationError);
    });

    it('rejects DEPLOY without GAS_LIMIT', function () {
        expect(() => actions.createAction({
            action: 'DEPLOY',
            params: { code: 'x', gasLimit: undefined }
        })).to.throw(SDKValidationError);
    });

    it('rejects DEPLOY with invalid hex in CODE_ENCODING', function () {
        expect(() => actions.createAction({
            action: 'DEPLOY',
            params: { codeEncoding: 'not-hex!', gasLimit: 100000 }
        })).to.throw(SDKValidationError);
    });

    it('rejects DEPLOY with negative GAS_LIMIT', function () {
        expect(() => actions.createAction({
            action: 'DEPLOY',
            params: { code: 'x', gasLimit: -1 }
        })).to.throw(SDKValidationError);
    });

    it('rejects DEPLOY with non-integer GAS_LIMIT', function () {
        expect(() => actions.createAction({
            action: 'DEPLOY',
            params: { code: 'x', gasLimit: 100.5 }
        })).to.throw(SDKValidationError);
    });

    it('rejects DEPLOY with code exceeding 64KB', function () {
        expect(() => actions.createAction({
            action: 'DEPLOY',
            params: { code: LARGE_CONTRACT, gasLimit: 100000 }
        })).to.throw(SDKValidationError);
    });

    it('rejects constructor params containing pipe characters', function () {
        expect(() => actions.createAction({
            action: 'DEPLOY',
            params: {
                code: 'var x = 1;',
                gasLimit: 100000,
                constructorParams: ['valid', 'in|valid']
            }
        })).to.throw(SDKValidationError);
    });

    it('rejects constructor params containing semicolons', function () {
        expect(() => actions.createAction({
            action: 'DEPLOY',
            params: {
                code: 'var x = 1;',
                gasLimit: 100000,
                constructorParams: ['valid', 'in;valid']
            }
        })).to.throw(SDKValidationError);
    });
});


// ===========================================================================
// Section 2: EXECUTE action
// ===========================================================================

describe('VM Actions – EXECUTE', function () {

    let actions;
    beforeEach(function () { actions = createActions(); });

    it('creates EXECUTE with method and no params', function () {
        let result = actions.createAction({
            action: 'EXECUTE',
            params: { contractActionIndex: 12345, method: 'increment' }
        });
        expect(result.action).to.equal('EXECUTE');
        expect(result.actionString).to.equal('EXECUTE|0|12345|increment');
    });

    it('creates EXECUTE with method and params', function () {
        let result = actions.createAction({
            action: 'EXECUTE',
            params: {
                contractActionIndex: 12345,
                method: 'transfer',
                params: [ADDR, '100']
            }
        });
        expect(result.actionString).to.equal(
            'EXECUTE|0|12345|transfer|' + ADDR + '|100'
        );
    });

    it('creates EXECUTE with single param (auto-wrapped to array)', function () {
        let result = actions.createAction({
            action: 'EXECUTE',
            params: {
                contractActionIndex: 99,
                method: 'greet',
                params: 'world'
            }
        });
        expect(result.actionString).to.equal('EXECUTE|0|99|greet|world');
    });

    it('creates EXECUTE with many params', function () {
        let result = actions.createAction({
            action: 'EXECUTE',
            params: {
                contractActionIndex: 1,
                method: 'swap',
                params: ['TOKENA', '100', 'TOKENB', '200', 'memo']
            }
        });
        let parts = result.actionString.split('|');
        expect(parts).to.deep.equal(['EXECUTE', '0', '1', 'swap', 'TOKENA', '100', 'TOKENB', '200', 'memo']);
    });

    it('rejects EXECUTE without CONTRACT_ACTION_INDEX', function () {
        expect(() => actions.createAction({
            action: 'EXECUTE',
            params: { method: 'foo' }
        })).to.throw(SDKValidationError);
    });

    it('rejects EXECUTE without METHOD', function () {
        expect(() => actions.createAction({
            action: 'EXECUTE',
            params: { contractActionIndex: 1 }
        })).to.throw(SDKValidationError);
    });

    it('rejects EXECUTE with non-numeric CONTRACT_ACTION_INDEX', function () {
        expect(() => actions.createAction({
            action: 'EXECUTE',
            params: { contractActionIndex: 'abc', method: 'foo' }
        })).to.throw(SDKValidationError);
    });

    it('rejects EXECUTE params containing pipes', function () {
        expect(() => actions.createAction({
            action: 'EXECUTE',
            params: {
                contractActionIndex: 1,
                method: 'test',
                params: ['valid', 'in|valid']
            }
        })).to.throw(SDKValidationError);
    });

    it('rejects EXECUTE with METHOD containing pipes', function () {
        expect(() => actions.createAction({
            action: 'EXECUTE',
            params: { contractActionIndex: 1, method: 'bad|method' }
        })).to.throw(SDKValidationError);
    });
});


// ===========================================================================
// Section 3: DEPOSIT action
// ===========================================================================

describe('VM Actions – DEPOSIT', function () {

    let actions;
    beforeEach(function () { actions = createActions(); });

    it('creates DEPOSIT with tick name', function () {
        let result = actions.createAction({
            action: 'DEPOSIT',
            params: { contractActionIndex: 12345, tick: 'MYTOKEN', quantity: '1000' }
        });
        expect(result.action).to.equal('DEPOSIT');
        expect(result.actionString).to.equal('DEPOSIT|0|12345|MYTOKEN|1000');
    });

    it('creates DEPOSIT with tick ID reference', function () {
        let result = actions.createAction({
            action: 'DEPOSIT',
            params: { contractActionIndex: 42, tick: '^99', quantity: '500' }
        });
        expect(result.actionString).to.equal('DEPOSIT|0|42|^99|500');
    });

    it('rejects DEPOSIT without CONTRACT_ACTION_INDEX', function () {
        expect(() => actions.createAction({
            action: 'DEPOSIT',
            params: { tick: 'TOKEN', quantity: '100' }
        })).to.throw(SDKValidationError);
    });

    it('rejects DEPOSIT without TICK', function () {
        expect(() => actions.createAction({
            action: 'DEPOSIT',
            params: { contractActionIndex: 1, quantity: '100' }
        })).to.throw(SDKValidationError);
    });

    it('rejects DEPOSIT without QUANTITY', function () {
        expect(() => actions.createAction({
            action: 'DEPOSIT',
            params: { contractActionIndex: 1, tick: 'TOKEN' }
        })).to.throw(SDKValidationError);
    });

    it('rejects DEPOSIT with non-positive QUANTITY', function () {
        expect(() => actions.createAction({
            action: 'DEPOSIT',
            params: { contractActionIndex: 1, tick: 'TOKEN', quantity: '0' }
        })).to.throw(SDKValidationError);
    });

    it('rejects DEPOSIT with negative QUANTITY', function () {
        expect(() => actions.createAction({
            action: 'DEPOSIT',
            params: { contractActionIndex: 1, tick: 'TOKEN', quantity: '-10' }
        })).to.throw(SDKValidationError);
    });
});


// ===========================================================================
// Section 4: WITHDRAW action
// ===========================================================================

describe('VM Actions – WITHDRAW', function () {

    let actions;
    beforeEach(function () { actions = createActions(); });

    it('creates WITHDRAW with tick name', function () {
        let result = actions.createAction({
            action: 'WITHDRAW',
            params: { contractActionIndex: 12345, tick: 'MYTOKEN', quantity: '500' }
        });
        expect(result.action).to.equal('WITHDRAW');
        expect(result.actionString).to.equal('WITHDRAW|0|12345|MYTOKEN|500');
    });

    it('creates WITHDRAW with tick ID reference', function () {
        let result = actions.createAction({
            action: 'WITHDRAW',
            params: { contractActionIndex: 42, tick: '^99', quantity: '250' }
        });
        expect(result.actionString).to.equal('WITHDRAW|0|42|^99|250');
    });

    it('rejects WITHDRAW without required fields', function () {
        expect(() => actions.createAction({
            action: 'WITHDRAW',
            params: { tick: 'TOKEN', quantity: '100' }
        })).to.throw(SDKValidationError);
    });

    it('rejects WITHDRAW with non-positive QUANTITY', function () {
        expect(() => actions.createAction({
            action: 'WITHDRAW',
            params: { contractActionIndex: 1, tick: 'TOKEN', quantity: '0' }
        })).to.throw(SDKValidationError);
    });
});


// ===========================================================================
// Section 5: FormatSelector – rest-field handling
// ===========================================================================

describe('FormatSelector – rest-field support', function () {

    it('isRestField detects ...PREFIX fields', function () {
        expect(FormatSelector.isRestField('...PARAMS')).to.be.true;
        expect(FormatSelector.isRestField('...CONSTRUCTOR_PARAMS')).to.be.true;
        expect(FormatSelector.isRestField('PARAMS')).to.be.false;
        expect(FormatSelector.isRestField('METHOD')).to.be.false;
    });

    it('baseFieldName strips ... prefix', function () {
        expect(FormatSelector.baseFieldName('...PARAMS')).to.equal('PARAMS');
        expect(FormatSelector.baseFieldName('...CONSTRUCTOR_PARAMS')).to.equal('CONSTRUCTOR_PARAMS');
        expect(FormatSelector.baseFieldName('METHOD')).to.equal('METHOD');
    });

    it('selects EXECUTE format', function () {
        let selected = FormatSelector.select('EXECUTE', {
            CONTRACT_ACTION_INDEX: 123,
            METHOD: 'swap'
        });
        expect(selected.version).to.equal(0);
    });

    it('selects DEPLOY format', function () {
        let selected = FormatSelector.select('DEPLOY', {
            CODE_ENCODING: 'aabbcc',
            GAS_LIMIT: 100000
        });
        expect(selected.version).to.equal(0);
    });

    it('serializes EXECUTE with no params', function () {
        let str = FormatSelector.serialize('EXECUTE', 0, {
            CONTRACT_ACTION_INDEX: '123',
            METHOD: 'increment'
        });
        expect(str).to.equal('EXECUTE|0|123|increment');
    });

    it('serializes EXECUTE with params array', function () {
        let str = FormatSelector.serialize('EXECUTE', 0, {
            CONTRACT_ACTION_INDEX: '123',
            METHOD: 'transfer',
            PARAMS: [ADDR, '100']
        });
        expect(str).to.equal('EXECUTE|0|123|transfer|' + ADDR + '|100');
    });

    it('serializes DEPLOY with constructor params', function () {
        let str = FormatSelector.serialize('DEPLOY', 0, {
            CODE_ENCODING: 'aabb',
            GAS_LIMIT: '50000',
            CONSTRUCTOR_PARAMS: ['arg1', 'arg2']
        });
        expect(str).to.equal('DEPLOY|0|aabb|50000|arg1|arg2');
    });

    it('serializes DEPLOY without constructor params', function () {
        let str = FormatSelector.serialize('DEPLOY', 0, {
            CODE_ENCODING: 'aabb',
            GAS_LIMIT: '50000'
        });
        expect(str).to.equal('DEPLOY|0|aabb|50000');
    });

    it('serializes DEPOSIT', function () {
        let str = FormatSelector.serialize('DEPOSIT', 0, {
            CONTRACT_ACTION_INDEX: '42',
            TICK: 'TOKEN',
            QUANTITY: '1000'
        });
        expect(str).to.equal('DEPOSIT|0|42|TOKEN|1000');
    });

    it('serializes WITHDRAW', function () {
        let str = FormatSelector.serialize('WITHDRAW', 0, {
            CONTRACT_ACTION_INDEX: '42',
            TICK: 'TOKEN',
            QUANTITY: '500'
        });
        expect(str).to.equal('WITHDRAW|0|42|TOKEN|500');
    });

    it('estimates EXECUTE length with params', function () {
        let length = FormatSelector.estimateLength('EXECUTE', 0, {
            CONTRACT_ACTION_INDEX: '123',
            METHOD: 'swap',
            PARAMS: ['TOKENA', '100']
        });
        // EXECUTE|0|123|swap|TOKENA|100 = 30 chars
        expect(length).to.equal('EXECUTE|0|123|swap|TOKENA|100'.length);
    });
});


// ===========================================================================
// Section 6: Validator – VM action rules
// ===========================================================================

describe('Validator – VM action rules', function () {

    let validator;
    beforeEach(function () { validator = new Validator(new Utility()); });

    it('validates valid DEPLOY fields', function () {
        let errors = validator.validate('DEPLOY', {
            CODE_ENCODING: 'aabbccdd',
            GAS_LIMIT: 100000
        });
        expect(errors).to.have.lengthOf(0);
    });

    it('rejects DEPLOY with non-hex CODE_ENCODING', function () {
        let errors = validator.validate('DEPLOY', {
            CODE_ENCODING: 'xyz',
            GAS_LIMIT: 100000
        });
        expect(errors.some(e => e.code === 'INVALID_FIELD_VALUE' && e.details.field === 'CODE_ENCODING')).to.be.true;
    });

    it('rejects DEPLOY with zero GAS_LIMIT', function () {
        let errors = validator.validate('DEPLOY', {
            CODE_ENCODING: 'aabb',
            GAS_LIMIT: 0
        });
        expect(errors.some(e => e.details.field === 'GAS_LIMIT')).to.be.true;
    });

    it('validates valid EXECUTE fields', function () {
        let errors = validator.validate('EXECUTE', {
            CONTRACT_ACTION_INDEX: 123,
            METHOD: 'swap'
        });
        expect(errors).to.have.lengthOf(0);
    });

    it('rejects EXECUTE with empty METHOD', function () {
        let errors = validator.validate('EXECUTE', {
            CONTRACT_ACTION_INDEX: 123,
            METHOD: ''
        });
        expect(errors.length).to.be.greaterThan(0);
    });

    it('rejects EXECUTE with METHOD containing pipe', function () {
        let errors = validator.validate('EXECUTE', {
            CONTRACT_ACTION_INDEX: 123,
            METHOD: 'bad|method'
        });
        expect(errors.some(e => e.code === 'FORBIDDEN_CHARACTER')).to.be.true;
    });

    it('validates valid DEPOSIT fields', function () {
        let errors = validator.validate('DEPOSIT', {
            CONTRACT_ACTION_INDEX: 42,
            TICK: 'TOKEN',
            QUANTITY: 1000
        });
        expect(errors).to.have.lengthOf(0);
    });

    it('rejects DEPOSIT with non-positive QUANTITY', function () {
        let errors = validator.validate('DEPOSIT', {
            CONTRACT_ACTION_INDEX: 42,
            TICK: 'TOKEN',
            QUANTITY: 0
        });
        expect(errors.some(e => e.details.field === 'QUANTITY')).to.be.true;
    });

    it('validates valid WITHDRAW fields', function () {
        let errors = validator.validate('WITHDRAW', {
            CONTRACT_ACTION_INDEX: 42,
            TICK: 'TOKEN',
            QUANTITY: 500
        });
        expect(errors).to.have.lengthOf(0);
    });

    it('validates EXECUTE params array with forbidden chars', function () {
        let errors = validator.validate('EXECUTE', {
            CONTRACT_ACTION_INDEX: 1,
            METHOD: 'test',
            PARAMS: ['valid', 'in|valid']
        });
        expect(errors.some(e => e.code === 'INVALID_PARAM_VALUE')).to.be.true;
    });

    it('validates CONSTRUCTOR_PARAMS with forbidden chars', function () {
        let errors = validator.validate('DEPLOY', {
            CODE_ENCODING: 'aabb',
            GAS_LIMIT: 100000,
            CONSTRUCTOR_PARAMS: ['valid', 'in;valid']
        });
        expect(errors.some(e => e.code === 'INVALID_PARAM_VALUE')).to.be.true;
    });

    it('BATCH rejects DEPLOY', function () {
        let errors = validator.validate('BATCH', {
            COMMAND: 'DEPLOY|0|aabb|100000'
        });
        expect(errors.some(e => e.code === 'BATCH_CONSTRAINT' && e.message.includes('DEPLOY'))).to.be.true;
    });

    it('BATCH allows EXECUTE', function () {
        let errors = validator.validate('BATCH', {
            COMMAND: 'EXECUTE|0|123|swap;SEND|0|TOKEN|100|addr1'
        });
        let deployErrors = errors.filter(e => e.code === 'BATCH_CONSTRAINT' && e.message.includes('EXECUTE'));
        expect(deployErrors).to.have.lengthOf(0);
    });
});


// ===========================================================================
// Section 7: ContractUtils
// ===========================================================================

describe('ContractUtils', function () {

    let utils;
    beforeEach(function () { utils = new ContractUtils(); });

    describe('encode / decode', function () {

        it('round-trips UTF-8 source code', function () {
            let hex = utils.encode(SIMPLE_CONTRACT);
            expect(hex).to.match(/^[0-9a-f]+$/);
            let decoded = utils.decode(hex);
            expect(decoded).to.equal(SIMPLE_CONTRACT);
        });

        it('encode throws for non-string input', function () {
            expect(() => utils.encode(123)).to.throw(SDKContractError);
        });

        it('decode throws for invalid hex', function () {
            expect(() => utils.decode('not-hex!')).to.throw(SDKContractError);
        });
    });

    describe('checkCodeSize', function () {

        it('accepts code within limit', function () {
            let result = utils.checkCodeSize('var x = 1;');
            expect(result.withinLimit).to.be.true;
            expect(result.bytes).to.be.lessThan(65536);
            expect(result.limit).to.equal(65536);
        });

        it('rejects code exceeding limit', function () {
            let result = utils.checkCodeSize(LARGE_CONTRACT);
            expect(result.withinLimit).to.be.false;
            expect(result.bytes).to.be.greaterThan(65536);
        });
    });

    describe('validate', function () {

        it('accepts valid JavaScript', function () {
            let result = utils.validate('module.exports = function() { return 1; }');
            expect(result.valid).to.be.true;
        });

        it('rejects syntax errors', function () {
            let result = utils.validate('function( { broken');
            expect(result.valid).to.be.false;
            expect(result.error).to.include('Syntax error');
        });

        it('rejects __gas usage', function () {
            let result = utils.validate('var __gas = 1;');
            expect(result.valid).to.be.false;
            expect(result.error).to.include('__gas');
        });

        it('rejects oversized code', function () {
            let result = utils.validate(LARGE_CONTRACT);
            expect(result.valid).to.be.false;
            expect(result.error).to.include('byte limit');
        });

        it('returns float warnings', function () {
            let result = utils.validate('var x = 0.5; module.exports = function() { return x; }');
            expect(result.valid).to.be.true;
            if (result.warnings) {
                expect(result.warnings.length).to.be.greaterThan(0);
                expect(result.warnings[0]).to.include('Float');
            }
        });

        it('rejects non-string input', function () {
            let result = utils.validate(123);
            expect(result.valid).to.be.false;
        });
    });

    describe('checkFloatUsage', function () {

        it('detects float literals', function () {
            let warnings = utils.checkFloatUsage('var price = 1.5; var rate = 0.01;');
            expect(warnings.length).to.be.greaterThan(0);
        });

        it('returns empty for integer-only code', function () {
            let warnings = utils.checkFloatUsage('var x = 1; var y = 2;');
            expect(warnings).to.have.lengthOf(0);
        });
    });

    describe('suggestGasLimit', function () {

        it('returns a suggestion for simple code', function () {
            let result = utils.suggestGasLimit('module.exports = function() { return 1; }');
            expect(result.suggested).to.be.a('number');
            expect(result.suggested).to.be.greaterThan(0);
            expect(result.rationale).to.be.a('string');
        });

        it('suggests higher gas for complex code', function () {
            let simple = utils.suggestGasLimit('module.exports = function() { return 1; }');
            let complex = utils.suggestGasLimit(`
                module.exports = {
                    swap: function(xchain) {
                        for (var i = 0; i < 10; i++) {
                            xchain.state.set('k' + i, 'v');
                        }
                        xchain.emit.send({ tick: 'T', destination: 'addr', quantity: '1' });
                        xchain.emit.send({ tick: 'T', destination: 'addr', quantity: '2' });
                        return 'done';
                    }
                };
            `);
            expect(complex.suggested).to.be.greaterThan(simple.suggested);
        });
    });
});


// ===========================================================================
// Section 8: ContractClient
// ===========================================================================

describe('ContractClient', function () {

    it('constructor stores contractActionIndex', function () {
        let mockSdk = {};
        let client = new ContractClient(mockSdk, 12345);
        expect(client.contractActionIndex).to.equal(12345);
    });

    it('constructor rejects missing contractActionIndex', function () {
        expect(() => new ContractClient({}, undefined)).to.throw(SDKContractError);
        expect(() => new ContractClient({}, null)).to.throw(SDKContractError);
    });

    it('call() delegates to sdk.execute()', async function () {
        let captured = null;
        let mockSdk = {
            execute: async function(params, encoder) { captured = { params, encoder }; return { action: 'EXECUTE' }; }
        };
        let client = new ContractClient(mockSdk, 42);
        let result = await client.call('swap', ['TOKENA', '100'], { pubkey: 'pk' });

        expect(result.action).to.equal('EXECUTE');
        expect(captured.params.contractActionIndex).to.equal(42);
        expect(captured.params.method).to.equal('swap');
        expect(captured.params.params).to.deep.equal(['TOKENA', '100']);
        expect(captured.encoder.pubkey).to.equal('pk');
    });

    it('deposit() delegates to sdk.deposit()', async function () {
        let captured = null;
        let mockSdk = {
            deposit: async function(params, encoder) { captured = params; return { action: 'DEPOSIT' }; }
        };
        let client = new ContractClient(mockSdk, 42);
        await client.deposit('TOKEN', '500');

        expect(captured.contractActionIndex).to.equal(42);
        expect(captured.tick).to.equal('TOKEN');
        expect(captured.quantity).to.equal('500');
    });

    it('withdraw() delegates to sdk.withdraw()', async function () {
        let captured = null;
        let mockSdk = {
            withdraw: async function(params, encoder) { captured = params; return { action: 'WITHDRAW' }; }
        };
        let client = new ContractClient(mockSdk, 42);
        await client.withdraw('TOKEN', '250');

        expect(captured.contractActionIndex).to.equal(42);
        expect(captured.tick).to.equal('TOKEN');
        expect(captured.quantity).to.equal('250');
    });
});


// ===========================================================================
// Section 9: Module exports
// ===========================================================================

describe('VM module exports', function () {

    it('exports SDKContractError', function () {
        const mod = require('../index.js');
        expect(mod).to.have.property('SDKContractError');
        expect(mod.SDKContractError).to.be.a('function');
    });

    it('exports ContractClient', function () {
        const mod = require('../index.js');
        expect(mod).to.have.property('ContractClient');
        expect(mod.ContractClient).to.be.a('function');
    });

    it('exports ContractUtils', function () {
        const mod = require('../index.js');
        expect(mod).to.have.property('ContractUtils');
        expect(mod.ContractUtils).to.be.a('function');
    });

    it('XChainSDK has contracts namespace', function () {
        const { XChainSDK } = require('../index.js');
        let sdk = new XChainSDK({ network: 'bitcoin-regtest' });
        expect(sdk.contracts).to.be.an.instanceOf(require('../src/contracts.js'));
    });

    it('XChainSDK has contract() factory', function () {
        const { XChainSDK } = require('../index.js');
        let sdk = new XChainSDK({ network: 'bitcoin-regtest' });
        expect(sdk.contract).to.be.a('function');
        let client = sdk.contract(123);
        expect(client).to.be.an.instanceOf(require('../src/contractClient.js'));
        expect(client.contractActionIndex).to.equal(123);
    });
});


// ===========================================================================
// Section 10: XChainSDK convenience methods
// ===========================================================================

describe('XChainSDK – VM convenience methods', function () {

    const { XChainSDK } = require('../index.js');
    let sdk;
    beforeEach(function () { sdk = new XChainSDK({ network: 'bitcoin-regtest' }); });

    it('deploy() creates DEPLOY action', async function () {
        let result = await sdk.deploy({ code: 'var x = 1;', gasLimit: 100000 });
        expect(result.action).to.equal('DEPLOY');
        expect(result.actionString).to.match(/^DEPLOY\|0\|/);
    });

    it('execute() creates EXECUTE action', async function () {
        let result = await sdk.execute({ contractActionIndex: 42, method: 'swap', params: ['A', '100'] });
        expect(result.action).to.equal('EXECUTE');
        expect(result.actionString).to.equal('EXECUTE|0|42|swap|A|100');
    });

    it('deposit() creates DEPOSIT action', async function () {
        let result = await sdk.deposit({ contractActionIndex: 42, tick: 'TOKEN', quantity: '500' });
        expect(result.action).to.equal('DEPOSIT');
        expect(result.actionString).to.equal('DEPOSIT|0|42|TOKEN|500');
    });

    it('withdraw() creates WITHDRAW action', async function () {
        let result = await sdk.withdraw({ contractActionIndex: 42, tick: 'TOKEN', quantity: '250' });
        expect(result.action).to.equal('WITHDRAW');
        expect(result.actionString).to.equal('WITHDRAW|0|42|TOKEN|250');
    });

    it('getActions() includes VM actions', function () {
        let allActions = sdk.getActions();
        expect(allActions).to.include('DEPLOY');
        expect(allActions).to.include('EXECUTE');
        expect(allActions).to.include('DEPOSIT');
        expect(allActions).to.include('WITHDRAW');
    });

    it('validateAction() works for VM actions', function () {
        let valid = sdk.validateAction('EXECUTE', { contractActionIndex: 1, method: 'test' });
        expect(valid.valid).to.be.true;

        let invalid = sdk.validateAction('EXECUTE', { contractActionIndex: 1 });
        expect(invalid.valid).to.be.false;
    });
});


// ===========================================================================
// Section 11: BatchBuilder – VM action integration
// ===========================================================================

describe('BatchBuilder – VM actions', function () {

    const { XChainSDK } = require('../index.js');
    let sdk;
    beforeEach(function () { sdk = new XChainSDK({ network: 'bitcoin-regtest' }); });

    it('allows EXECUTE in BATCH', async function () {
        let result = await sdk.batch()
            .send({ tick: 'TOKEN', amount: 100, destination: ADDR })
            .execute({ contractActionIndex: 42, method: 'swap', params: ['A', '100'] })
            .build();
        expect(result.action).to.equal('BATCH');
        expect(result.actionString).to.include('EXECUTE|0|42|swap|A|100');
    });

    it('allows DEPOSIT in BATCH', async function () {
        let result = await sdk.batch()
            .deposit({ contractActionIndex: 42, tick: 'TOKEN', quantity: '500' })
            .build();
        expect(result.action).to.equal('BATCH');
        expect(result.actionString).to.include('DEPOSIT|0|42|TOKEN|500');
    });

    it('allows WITHDRAW in BATCH', async function () {
        let result = await sdk.batch()
            .withdraw({ contractActionIndex: 42, tick: 'TOKEN', quantity: '250' })
            .build();
        expect(result.action).to.equal('BATCH');
        expect(result.actionString).to.include('WITHDRAW|0|42|TOKEN|250');
    });

    it('rejects DEPLOY in BATCH', function () {
        expect(() => sdk.batch()
            .add('DEPLOY', { code: 'x', gasLimit: 100000 })
            .build()
        ).to.throw(SDKValidationError, /DEPLOY/);
    });
});


// ===========================================================================
// Section 12: Round-trip tests
// ===========================================================================

describe('VM Actions – round-trip serialize → verify', function () {

    let actions;
    beforeEach(function () { actions = createActions(); });

    it('DEPLOY fields match action string', function () {
        let code = 'module.exports = function() { return 1; }';
        let hex = Buffer.from(code, 'utf8').toString('hex');
        let result = actions.createAction({
            action: 'DEPLOY',
            params: { code: code, gasLimit: 200000 }
        });
        let parts = result.actionString.split('|');
        expect(parts[0]).to.equal('DEPLOY');
        expect(parts[1]).to.equal('0');
        expect(parts[2]).to.equal(hex);
        expect(parts[3]).to.equal('200000');
    });

    it('EXECUTE fields match action string', function () {
        let result = actions.createAction({
            action: 'EXECUTE',
            params: { contractActionIndex: 999, method: 'balanceOf', params: [ADDR] }
        });
        let parts = result.actionString.split('|');
        expect(parts[0]).to.equal('EXECUTE');
        expect(parts[1]).to.equal('0');
        expect(parts[2]).to.equal('999');
        expect(parts[3]).to.equal('balanceOf');
        expect(parts[4]).to.equal(ADDR);
    });

    it('DEPOSIT fields match action string', function () {
        let result = actions.createAction({
            action: 'DEPOSIT',
            params: { contractActionIndex: 500, tick: 'XCHAIN', quantity: '1000000' }
        });
        let parts = result.actionString.split('|');
        expect(parts).to.deep.equal(['DEPOSIT', '0', '500', 'XCHAIN', '1000000']);
    });

    it('WITHDRAW fields match action string', function () {
        let result = actions.createAction({
            action: 'WITHDRAW',
            params: { contractActionIndex: 500, tick: 'XCHAIN', quantity: '500000' }
        });
        let parts = result.actionString.split('|');
        expect(parts).to.deep.equal(['WITHDRAW', '0', '500', 'XCHAIN', '500000']);
    });
});


// ===========================================================================
// Section 13: Encoding pre-flight validation
// ===========================================================================

describe('VM Actions – encoding pre-flight', function () {

    let actions;
    beforeEach(function () { actions = createActions(); });

    it('DEPLOY rejects OP_RETURN encoding (too large)', function () {
        expect(() => actions.createAction({
            action: 'DEPLOY',
            params: { code: 'module.exports = function() { return 1; }', gasLimit: 100000 },
            encoder: { encoding: 'OP_RETURN' }
        })).to.throw(SDKValidationError, /OP_RETURN/);
    });

    it('DEPLOY accepts P2SH encoding', function () {
        let result = actions.createAction({
            action: 'DEPLOY',
            params: { code: 'var x = 1;', gasLimit: 100000 },
            encoder: { encoding: 'P2SH' }
        });
        expect(result.action).to.equal('DEPLOY');
    });

    it('short EXECUTE can use OP_RETURN', function () {
        let result = actions.createAction({
            action: 'EXECUTE',
            params: { contractActionIndex: 1, method: 'inc' },
            encoder: { encoding: 'OP_RETURN' }
        });
        expect(result.action).to.equal('EXECUTE');
    });
});


// ===========================================================================
// Section 14: Introspection – getActionFields / getActionFormats
// ===========================================================================

describe('VM Actions – introspection', function () {

    let actions;
    beforeEach(function () { actions = createActions(); });

    it('getActionFormats returns DEPLOY formats', function () {
        let formats = actions.getActionFormats('DEPLOY');
        expect(formats).to.have.property('0');
    });

    it('getActionFormats returns EXECUTE formats', function () {
        let formats = actions.getActionFormats('EXECUTE');
        expect(formats).to.have.property('0');
    });

    it('getActionFields returns DEPLOY fields', function () {
        let fields = actions.getActionFields('DEPLOY', 0);
        expect(fields).to.include('VERSION');
        expect(fields).to.include('CODE_ENCODING');
        expect(fields).to.include('GAS_LIMIT');
    });

    it('getActionFields returns EXECUTE fields', function () {
        let fields = actions.getActionFields('EXECUTE', 0);
        expect(fields).to.include('VERSION');
        expect(fields).to.include('CONTRACT_ACTION_INDEX');
        expect(fields).to.include('METHOD');
    });

    it('getActionFields returns DEPOSIT fields', function () {
        let fields = actions.getActionFields('DEPOSIT', 0);
        expect(fields).to.include('CONTRACT_ACTION_INDEX');
        expect(fields).to.include('TICK');
        expect(fields).to.include('QUANTITY');
    });

    it('getActionFields returns WITHDRAW fields', function () {
        let fields = actions.getActionFields('WITHDRAW', 0);
        expect(fields).to.include('CONTRACT_ACTION_INDEX');
        expect(fields).to.include('TICK');
        expect(fields).to.include('QUANTITY');
    });
});
