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
const { SDKError } = require('../../../src/utils/errors.js');

function createActions() {
    let sdk = { config: config.getConfig(), util: new Utility() };
    return new Actions(sdk);
}

// A real-looking segwit address (42 chars – passes the loose isCryptoAddress check)
const VALID_DEST = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';

function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function runRandomActions() {
    let actions = createActions();
    let validActions = actions.getActions();

    // Pool of random field values (mix of valid-ish and garbage)
    let randomValues = [
        'SOMETOKEN', 'tok', '123', '', null, undefined,
        0, -1, 999999, true, false, NaN, Infinity, [], {}, 'hello world',
        VALID_DEST, 'bc1invalid', '1A1zP1eP5QGefi2DMPTfTL5SLmv7Divf', // P2PKH len-34
        'SHORT', '!@#$%', 'A'.repeat(300), '你好', '🔥',
    ];

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

    return { successes, sdkErrors, badErrors };
}

// Group 8: Rapid-fire random actions

describe('Fuzz – Group 8: Rapid-fire random actions', function() {

    it('100 random createAction calls → all errors are SDKError subclasses', function() {
        let { successes, sdkErrors, badErrors } = runRandomActions();

        // Report
        // All errors must be SDKError subclasses; no raw runtime errors allowed
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
