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

const { expect } = require('chai');
const bitcoin = require('bitcoinjs-lib');
const {
    ALLOWED_SIGHASH,
    sighashAllowed,
    disallowedSighashError,
} = require('../../../../src/cosigner/policy/sighash_policy.js');

describe('sighash policy', function () {
    it('allows only SIGHASH_DEFAULT in the explicit allowlist', function () {
        expect(ALLOWED_SIGHASH.size).to.equal(1);
        expect([...ALLOWED_SIGHASH]).to.deep.equal([bitcoin.Transaction.SIGHASH_DEFAULT]);
        expect(bitcoin.Transaction.SIGHASH_DEFAULT).to.equal(0);
    });

    it('accepts unspecified and default sighash types', function () {
        expect(sighashAllowed(undefined)).to.equal(true);
        expect(sighashAllowed(0)).to.equal(true);
    });

    it('rejects non-default and null sighash types', function () {
        for (const hashType of [1, 2, 3, 0x81, null, 0x83]) {
            expect(sighashAllowed(hashType), String(hashType)).to.equal(false);
        }
    });

    it('formats disallowed sighash errors as two-digit hexadecimal', function () {
        expect(disallowedSighashError(1)).to.be.an.instanceof(Error)
            .with.property('message', 'disallowed sighashType 0x01 (only SIGHASH_DEFAULT is finalizable by this signer)');
        expect(disallowedSighashError(0x81).message).to.equal(
            'disallowed sighashType 0x81 (only SIGHASH_DEFAULT is finalizable by this signer)');
        expect(disallowedSighashError(0).message).to.equal(
            'disallowed sighashType 0x00 (only SIGHASH_DEFAULT is finalizable by this signer)');
    });
});
