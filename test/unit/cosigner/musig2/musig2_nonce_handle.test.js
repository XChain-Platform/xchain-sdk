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

const toHex = (b) => Buffer.from(b).toString('hex');

// Pin the documented nonce-handle contract: the secret nonce is found by array identity, once.
describe('MuSig2 secret nonce handle', function () {
    it('refuses a byte-equal copy of the publicNonce, then signs once with the original', function () {
        const musig = new MuSig2();
        const sk1 = crypto.randomBytes(32);
        const sk2 = crypto.randomBytes(32);
        const pk1 = secp256k1.getPublicKey(sk1, true);
        const pk2 = secp256k1.getPublicKey(sk2, true);
        const ctx = musig.aggregateKeys([pk1, pk2]);
        const msg = crypto.randomBytes(32);
        const n1 = musig.generateNonce({ publicKey: pk1, secretKey: sk1, msg, xOnlyPublicKey: ctx.xOnlyPubkey });
        const n2 = musig.generateNonce({ publicKey: pk2, secretKey: sk2, msg, xOnlyPublicKey: ctx.xOnlyPubkey });
        const session = musig.startSession(musig.aggregateNonces([n1, n2]), msg, [pk1, pk2]);

        const copies = [new Uint8Array(n1), Buffer.from(n1), Buffer.from(toHex(n1), 'hex')];
        for (const copy of copies) {
            expect(toHex(copy)).to.equal(toHex(n1));
            expect(() => musig.partialSign({ secretKey: sk1, publicNonce: copy, sessionKey: session }))
                .to.throw(/No secret nonce/);
        }

        const s1 = musig.partialSign({ secretKey: sk1, publicNonce: n1, sessionKey: session });
        expect(s1.length).to.equal(32);
        expect(() => musig.partialSign({ secretKey: sk1, publicNonce: n1, sessionKey: session }))
            .to.throw(/No secret nonce/);
    });
});
