// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect } = require('chai');

const CONFIG_PATH = '../../../src/config.js';
let originalValue;

function readStopCheckInterval() {
    delete require.cache[require.resolve(CONFIG_PATH)];
    return require(CONFIG_PATH).getConfig().STOP_CHECK_INTERVAL;
}

describe('STOP_CHECK_INTERVAL config', function () {
    beforeEach(function () {
        originalValue = process.env.STOP_CHECK_INTERVAL;
    });

    afterEach(function () {
        if (originalValue === undefined) delete process.env.STOP_CHECK_INTERVAL;
        else process.env.STOP_CHECK_INTERVAL = originalValue;
    });

    const cases = [
        { name: 'unset', value: undefined, expected: 5000 },
        { name: 'empty', value: '', expected: 5000 },
        { name: 'non-numeric', value: 'not-a-number', expected: 5000 },
        { name: 'negative', value: '-5', expected: 5000 },
        { name: 'zero', value: '0', expected: 0 },
        { name: 'positive', value: '42', expected: 42 },
    ];

    for (const testCase of cases) {
        it(`${testCase.name} yields ${testCase.expected}`, function () {
            if (testCase.value === undefined) delete process.env.STOP_CHECK_INTERVAL;
            else process.env.STOP_CHECK_INTERVAL = testCase.value;

            expect(readStopCheckInterval()).to.equal(testCase.expected);
        });
    }
});
