'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const outputPolicy = require('../../../src/cosigner/co_signer/output_policy.js');
const { toU64 } = require('../../../src/carrier/reconcile_encoded/script_matching.js');

describe('money-path toU64 exactness', function () {
    const unsafe = Number.MAX_SAFE_INTEGER + 1;

    for (const [name, parse] of [
        ['co-signer', outputPolicy.toU64],
        ['carrier reconciliation', toU64],
    ]) {
        it(name + ' refuses rounded Numbers and preserves exact forms', function () {
            assert.strictEqual(parse(unsafe), null);
            assert.strictEqual(parse(Number.MAX_SAFE_INTEGER), BigInt(Number.MAX_SAFE_INTEGER));
            assert.strictEqual(parse(9007199254740993n), 9007199254740993n);
            assert.strictEqual(parse(0), 0n);
            assert.strictEqual(parse(1.5), null);
            assert.strictEqual(parse(-1), null);
        });
    }

    it('co-signer fee accounting denies an unsafe input or output value', function () {
        const ctx = {
            maxFeeSats: 1000n,
            toU64: outputPolicy.toU64,
            deny: (code, detail) => ({ code, detail }),
        };
        const inputUnsafe = {
            txInputs: [{}], data: { inputs: [{ witnessUtxo: { value: unsafe } }] },
            txOutputs: [{ value: 1 }],
        };
        const outputUnsafe = {
            txInputs: [{}], data: { inputs: [{ witnessUtxo: { value: 1000 } }] },
            txOutputs: [{ value: unsafe }],
        };
        assert.strictEqual(outputPolicy.checkFee.call(ctx, inputUnsafe).code, 'CANNOT_CHECK_FEE');
        assert.strictEqual(outputPolicy.checkFee.call(ctx, outputUnsafe).code, 'CANNOT_CHECK_FEE');
    });
});
