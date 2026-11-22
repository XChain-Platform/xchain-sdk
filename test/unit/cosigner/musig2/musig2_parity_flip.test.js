// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect } = require('chai');
const crypto = require('crypto');
const MuSig2 = require('../../../../src/cosigner/musig2.js');
const { secp256k1 } = require('@noble/curves/secp256k1.js');

describe('MuSig2 duplicate participants', function () {
    it('aggregateKeys rejects parity-flipped copies of one participant', function () {
        const musig = new MuSig2();
        const pk = Buffer.from(secp256k1.getPublicKey(crypto.randomBytes(32), true));
        const flipped = Buffer.from(pk);
        flipped[0] ^= 1;
        expect(() => musig.aggregateKeys([pk, flipped])).to.throw(/pairwise distinct/);
        expect(() => musig.aggregateKeys([flipped.toString('hex'), pk.toString('hex')]))
            .to.throw(/pairwise distinct/);
    });
});
