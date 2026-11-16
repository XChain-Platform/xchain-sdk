// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('assert');
const {
    medianTimePast,
    assertMultipartActive
} = require('../../src/file/multipart_readiness.js');

function isInactive(error) {
    return error instanceof Error && error.code === 'MULTIPART_NOT_ACTIVE';
}

describe('multi-part file readiness', function () {
    describe('medianTimePast', function () {
        it('sorts an unsorted window after dropping unusable timestamps', function () {
            const times = [90, 20, NaN, 70, 10, Infinity, 60, 0, 40, 30, 50];

            assert.strictEqual(medianTimePast(times), 50);
        });

        it('ignores the twelfth entry even when it is the latest timestamp', function () {
            const firstEleven = [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];

            assert.strictEqual(medianTimePast([...firstEleven, 1000]), 6);
        });

        it('uses every usable timestamp on a short chain', function () {
            assert.strictEqual(medianTimePast([30, 10, 20]), 20);
        });

        it('drops non-number values instead of coercing them', function () {
            assert.strictEqual(medianTimePast([200, 100, '1', true]), 200);
        });

        it('returns null for an empty window', function () {
            assert.strictEqual(medianTimePast([]), null);
        });
    });

    describe('assertMultipartActive', function () {
        it('accepts the activation instant', function () {
            assert.strictEqual(assertMultipartActive([30, 10, 20], 20), 20);
        });

        it('refuses a median below the activation instant', function () {
            assert.throws(() => assertMultipartActive([30, 10, 20], 21), isInactive);
        });

        it('refuses an empty window', function () {
            assert.throws(() => assertMultipartActive([], 0), isInactive);
        });

        it('refuses null and undefined activation times', function () {
            assert.throws(() => assertMultipartActive([30, 10, 20], null), isInactive);
            assert.throws(() => assertMultipartActive([30, 10, 20], undefined), isInactive);
        });
    });
});
