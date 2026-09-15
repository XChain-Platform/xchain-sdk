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

// AES (method 3): pre-shared key
describe('MessagingUtils @crypto @regression', function () {

    let msg;
    beforeEach(function () { msg = new MessagingUtils(NETWORK); });

    describe('AES', function () {

        it('round-trips with a 32-byte key', function () {
            const key = crypto.randomBytes(32);
            const { ciphertext } = msg.aesEncrypt('topsecret', key);
            expect(msg.aesDecrypt(ciphertext, key).plaintext).to.equal('topsecret');
        });

        it('normalizes a short passphrase to 32 bytes (sha256) symmetrically', function () {
            const { ciphertext } = msg.aesEncrypt('msg', 'password');
            expect(msg.aesDecrypt(ciphertext, 'password').plaintext).to.equal('msg');
        });

        it('packs ciphertext as iv(12)+authTag(16)+data', function () {
            const key = crypto.randomBytes(32);
            const { ciphertext } = msg.aesEncrypt('A', key);
            expect(Buffer.from(ciphertext, 'hex').length).to.equal(12 + 16 + 1);
        });

        it('fails on wrong key and on tamper', function () {
            const key = crypto.randomBytes(32);
            const { ciphertext } = msg.aesEncrypt('secret', key);
            expectCode(() => msg.aesDecrypt(ciphertext, crypto.randomBytes(32)), 'DECRYPTION_FAILED');
            const buf = Buffer.from(ciphertext, 'hex'); buf[buf.length - 1] ^= 0xff;
            expectCode(() => msg.aesDecrypt(buf.toString('hex'), key), 'DECRYPTION_FAILED');
        });

        it('rejects short ciphertext, missing key, and bad key type', function () {
            const key = crypto.randomBytes(32);
            expectCode(() => msg.aesDecrypt('00', key), 'INVALID_CIPHERTEXT');
            expectCode(() => msg.aesEncrypt('m', null), 'INVALID_KEY');
            expectCode(() => msg.aesEncrypt('m', 12345), 'INVALID_TYPE');
        });

        it('uses a distinct IV per aesEncrypt call (nonce uniqueness)', function () {
            const key = crypto.randomBytes(32);
            // _aesEncrypt packs: iv(12) + authTag(16) + encrypted
            const IV_LEN = 12;
            const c1 = Buffer.from(msg.aesEncrypt('same', key).ciphertext, 'hex');
            const c2 = Buffer.from(msg.aesEncrypt('same', key).ciphertext, 'hex');
            const iv1 = c1.subarray(0, IV_LEN).toString('hex');
            const iv2 = c2.subarray(0, IV_LEN).toString('hex');
            expect(iv1).to.not.equal(iv2);
        });
    });
});
