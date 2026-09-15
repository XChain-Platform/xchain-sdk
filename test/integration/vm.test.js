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
 * XChain Platform SDK - VM Integration Tests
 *
 * Comprehensive tests for VM action support: DEPLOY, EXECUTE, DEPOSIT,
 * WITHDRAW actions, contract utilities, contract client, format
 * selection, validation, batch integration, and explorer methods.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const config     = require('../../src/config.js');
const Utility    = require('../../src/utils/utility.js');
const Actions    = require('../../src/actions/index.js');
const { SDKValidationError } = require('../../src/utils/errors.js');

const ADDR = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';

// Factory: create a fresh Actions instance
function createActions() {
    let sdk = { config: config.getConfig(), util: new Utility() };
    return new Actions(sdk);
}

const LARGE_CONTRACT = 'x'.repeat(65537); // exceeds 64KB


// DEPLOY action

describe('VM Actions – DEPLOY', function () {

    let actions;
    beforeEach(function () { actions = createActions(); });

    it('creates DEPLOY with raw code (auto base64-encoding)', function () {
        let result = actions.createAction({
            action: 'DEPLOY',
            params: { code: 'module.exports = {}', gasLimit: 100000 }
        });
        expect(result.action).to.equal('DEPLOY');
        expect(result.version).to.equal(0);
        expect(result.actionString).to.match(/^DEPLOY\|0\|/);
        expect(result.fields.CODE_ENCODING).to.equal(
            Buffer.from('module.exports = {}', 'utf8').toString('base64')
        );
        // '100000', not 100000: GAS_LIMIT is a NUMBER_FIELD, and setNumberFormats
        // canonicalizes every numeric field to its full-precision fixed-notation
        // wire string (JS doubles truncate supplies over 2^53 and emit scientific
        // notation for small decimals, both of which corrupt the ACTION string).
        // The value is what matters, so assert the wire form and the magnitude.
        expect(result.fields.GAS_LIMIT).to.equal('100000');
        expect(Number(result.fields.GAS_LIMIT)).to.equal(100000);
        expect(result.actionString).to.include('|100000');
        expect(result.fields.CODE).to.be.undefined;
    });

    it('creates DEPLOY with pre-encoded base64', function () {
        let b64 = Buffer.from('var x = 1;', 'utf8').toString('base64');
        let result = actions.createAction({
            action: 'DEPLOY',
            params: { codeEncoding: b64, gasLimit: 50000 }
        });
        expect(result.fields.CODE_ENCODING).to.equal(b64);
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
        // parts[2] = base64 code, parts[3] = gas limit, parts[4+] = constructor params
        expect(parts[parts.length - 3]).to.equal('arg1');
        expect(parts[parts.length - 2]).to.equal('arg2');
        expect(parts[parts.length - 1]).to.equal('arg3');
    });
});

describe('VM Actions – DEPLOY', function () {

    let actions;
    beforeEach(function () { actions = createActions(); });

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

    it('rejects DEPLOY with invalid base64 in CODE_ENCODING', function () {
        expect(() => actions.createAction({
            action: 'DEPLOY',
            params: { codeEncoding: 'not-base64!', gasLimit: 100000 }
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
});

describe('VM Actions – DEPLOY', function () {

    let actions;
    beforeEach(function () { actions = createActions(); });

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


// EXECUTE action

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
});

describe('VM Actions – EXECUTE', function () {

    let actions;
    beforeEach(function () { actions = createActions(); });

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


// DEPOSIT action

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


// WITHDRAW action

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
