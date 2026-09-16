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
const config  = require('../../../src/config.js');
const Utility = require('../../../src/utils/utility.js');
const Actions = require('../../../src/actions/index.js');

// Factory: create a fresh Actions instance
function createActions() {
    let sdk = { config: config.getConfig(), util: new Utility() };
    return new Actions(sdk);
}

// Introspection – getActionFields / getActionFormats

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
