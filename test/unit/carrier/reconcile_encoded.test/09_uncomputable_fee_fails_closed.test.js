// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('assert');
const { reconcileFee } = require('../../../../src/carrier/reconcile_encoded.js');

function deny(code, detail) {
    const error = new Error(code);
    error.code = code;
    error.detail = detail;
    throw error;
}

function run(intent, inputs = { feeComputable: false, totalIn: 0n }) {
    return reconcileFee(intent, inputs, { totalOut: 90000n, phaseFunding: [] }, deny);
}

describe('reconcileFee unreadable input values', function () {
    it('denies an uncomputable fee with or without a valid cap', function () {
        assert.throws(() => run({}), (error) => error.code === 'UNCOMPUTABLE_FEE');
        assert.throws(() => run({ maxFeeSats: 10000 }),
            (error) => error.code === 'UNCOMPUTABLE_FEE');
    });

    it('validates a malformed cap before denying an uncomputable fee', function () {
        assert.throws(() => run({ maxFeeSats: 'not-sats' }),
            (error) => error.code === 'MALFORMED_FEE_CAP');
    });

    it('preserves computable fee accounting', function () {
        const result = run({}, { feeComputable: true, totalIn: 100000n });
        assert.strictEqual(result.fee, 10000n);
        assert.strictEqual(result.totalIn, 100000n);
    });
});
