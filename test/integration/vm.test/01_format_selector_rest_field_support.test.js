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
const FormatSelector = require('../../../src/protocol/format_selector.js');

const ADDR = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';

// FormatSelector – rest-field handling

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
});

describe('FormatSelector – rest-field support', function () {

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
