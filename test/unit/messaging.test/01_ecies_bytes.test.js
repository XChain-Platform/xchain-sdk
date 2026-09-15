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
const MessagingUtils = require('../../../src/actions/messaging.js');
const WalletUtils = require('../../../src/utils/wallet.js');

// Real secp256k1 keypairs (no stubbing) so these exercise the actual
// ECIES / ECDH / AES-GCM primitives end-to-end.
const NETWORK = 'bitcoin-regtest';
function keypair() { return new WalletUtils(NETWORK).generateKeyPair(); }

// Assert a thrown SDKMessagingError carries the expected `.code`.
function expectCode(fn, code) {
    expect(fn).to.throw().with.property('code', code);
}

// ECIES (method 1): binary payloads (gated-content key handoff)
describe('MessagingUtils @crypto @regression', function () {

    let msg;
    beforeEach(function () { msg = new MessagingUtils(NETWORK); });

    describe('ECIES (bytes)', function () {

        it('round-trips a 33-byte binary key handoff intact', function () {
            const bob = keypair();
            const payload = crypto.randomBytes(33);
            const { ciphertext } = msg.eciesEncryptBytes(payload, bob.publicKeyHex);
            const { plaintext } = msg.eciesDecryptBytes(ciphertext, bob.wif);
            expect(Buffer.isBuffer(plaintext)).to.equal(true);
            expect(plaintext.equals(payload)).to.equal(true);
        });

        it('preserves bytes that are not valid UTF-8', function () {
            const bob = keypair();
            const payload = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc0]);
            const { ciphertext } = msg.eciesEncryptBytes(payload, bob.publicKeyHex);
            expect(msg.eciesDecryptBytes(ciphertext, bob.wif).plaintext.equals(payload)).to.equal(true);
        });

        it('rejects a non-Buffer plaintext', function () {
            const bob = keypair();
            expectCode(() => msg.eciesEncryptBytes('a string', bob.publicKeyHex), 'INVALID_MESSAGE');
        });
    });
});
