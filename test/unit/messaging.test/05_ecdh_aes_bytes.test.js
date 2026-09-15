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

// High-level getMessages(): decryption integration
describe('MessagingUtils @crypto @regression', function () {

    let msg;
    beforeEach(function () { msg = new MessagingUtils(NETWORK); });

    describe('ECDH/AES (bytes)', function () {

        it('sessionEncryptBytes/sessionDecryptBytes round-trip arbitrary binary', function () {
            const secret = crypto.randomBytes(32);
            const payload = crypto.randomBytes(64);
            const { ciphertext } = msg.sessionEncryptBytes(payload, secret);
            const { plaintext } = msg.sessionDecryptBytes(ciphertext, secret);
            expect(Buffer.isBuffer(plaintext)).to.equal(true);
            expect(plaintext.equals(payload)).to.equal(true);
        });

        it('sessionEncryptBytes preserves non-utf8 bytes that string mode would corrupt', function () {
            const secret = crypto.randomBytes(32);
            const payload = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28]);
            const { ciphertext } = msg.sessionEncryptBytes(payload, secret);
            expect(msg.sessionDecryptBytes(ciphertext, secret).plaintext.equals(payload)).to.equal(true);
        });

        it('sessionDecryptBytes output is utf8-compatible with sessionDecrypt for text payloads', function () {
            const secret = crypto.randomBytes(32);
            const { ciphertext } = msg.sessionEncryptBytes(Buffer.from('hello bytes', 'utf8'), secret);
            expect(msg.sessionDecrypt(ciphertext, secret).plaintext).to.equal('hello bytes');
        });

        it('sessionEncryptBytes rejects strings and empty Buffers', function () {
            const secret = crypto.randomBytes(32);
            expectCode(() => msg.sessionEncryptBytes('a string', secret), 'INVALID_MESSAGE');
            expectCode(() => msg.sessionEncryptBytes(Buffer.alloc(0), secret), 'INVALID_MESSAGE');
        });

        it('sessionDecryptBytes fails cleanly on wrong secret', function () {
            const { ciphertext } = msg.sessionEncryptBytes(crypto.randomBytes(16), crypto.randomBytes(32));
            expectCode(() => msg.sessionDecryptBytes(ciphertext, crypto.randomBytes(32)), 'DECRYPTION_FAILED');
        });

        it('aesEncryptBytes/aesDecryptBytes round-trip arbitrary binary', function () {
            const key = crypto.randomBytes(32);
            const payload = crypto.randomBytes(48);
            const { ciphertext } = msg.aesEncryptBytes(payload, key);
            const { plaintext } = msg.aesDecryptBytes(ciphertext, key);
            expect(Buffer.isBuffer(plaintext)).to.equal(true);
            expect(plaintext.equals(payload)).to.equal(true);
        });

        it('aesEncryptBytes hashes short keys to 32 bytes like aesEncrypt', function () {
            const payload = crypto.randomBytes(20);
            const { ciphertext } = msg.aesEncryptBytes(payload, 'password');
            expect(msg.aesDecryptBytes(ciphertext, 'password').plaintext.equals(payload)).to.equal(true);
        });
    });
});

describe('MessagingUtils @crypto @regression', function () {

    let msg;
    beforeEach(function () { msg = new MessagingUtils(NETWORK); });

    describe('ECDH/AES (bytes)', function () {

        it('aesEncryptBytes rejects strings and empty Buffers', function () {
            const key = crypto.randomBytes(32);
            expectCode(() => msg.aesEncryptBytes('a string', key), 'INVALID_MESSAGE');
            expectCode(() => msg.aesEncryptBytes(Buffer.alloc(0), key), 'INVALID_MESSAGE');
        });

        it('aesDecryptBytes fails cleanly on wrong key', function () {
            const key = crypto.randomBytes(32);
            const { ciphertext } = msg.aesEncryptBytes(crypto.randomBytes(16), key);
            expectCode(() => msg.aesDecryptBytes(ciphertext, crypto.randomBytes(32)), 'DECRYPTION_FAILED');
        });

        it('aesDecrypt (string mode) still decrypts aesEncryptBytes text payloads', function () {
            const key = crypto.randomBytes(32);
            const { ciphertext } = msg.aesEncryptBytes(Buffer.from('text via bytes', 'utf8'), key);
            expect(msg.aesDecrypt(ciphertext, key).plaintext).to.equal('text via bytes');
        });
    });
});
