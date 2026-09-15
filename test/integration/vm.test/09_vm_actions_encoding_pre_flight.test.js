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
const { SDKValidationError } = require('../../../src/utils/errors.js');

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

// Encoding pre-flight validation

describe('VM Actions – encoding pre-flight', function () {

    let actions;
    beforeEach(function () { actions = createActions(); });

    // CODE serializes as base64 (1.33x, delimiter-safe), so a 40-byte one-liner
    // fits OP_RETURN's limit at 72 bytes; hex encoding (2x) would need 80
    // characters and blow the limit on its own. Both halves of that are worth
    // pinning: a contract of any real size still cannot use OP_RETURN, and a
    // trivial one can.
    it('DEPLOY rejects OP_RETURN encoding for a contract of any real size', function () {
        expect(() => actions.createAction({
            action: 'DEPLOY',
            params: { code: SIMPLE_CONTRACT, gasLimit: 100000 },
            encoder: { encoding: 'OP_RETURN' }
        })).to.throw(SDKValidationError, /OP_RETURN/);
    });

    it('DEPLOY of a one-liner fits OP_RETURN now that CODE is base64', function () {
        let result = actions.createAction({
            action: 'DEPLOY',
            params: { code: 'module.exports = function() { return 1; }', gasLimit: 100000 },
            encoder: { encoding: 'OP_RETURN' }
        });
        expect(Buffer.byteLength(result.actionString, 'utf8')).to.be.at.most(75);
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
