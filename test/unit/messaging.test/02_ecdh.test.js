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

// ECDH (method 2): session communication
describe('MessagingUtils @crypto @regression', function () {

    let msg;
    beforeEach(function () { msg = new MessagingUtils(NETWORK); });

    describe('ECDH', function () {

        it('generateSessionKey returns a 33-byte compressed pubkey', function () {
            const a = keypair();
            const { publicKey } = msg.generateSessionKey(a.wif);
            expect(Buffer.from(publicKey, 'hex').length).to.equal(33);
        });

        it('derives a symmetric 32-byte shared secret (both parties agree)', function () {
            const alice = keypair(), bob = keypair();
            const aPub = msg.generateSessionKey(alice.wif).publicKey;
            const bPub = msg.generateSessionKey(bob.wif).publicKey;
            const sA = msg.deriveSharedSecret(alice.wif, bPub).sharedSecret;
            const sB = msg.deriveSharedSecret(bob.wif, aPub).sharedSecret;
            expect(sA).to.equal(sB);
            expect(Buffer.from(sA, 'hex').length).to.equal(32);
        });

        it('completes a full handshake: Alice encrypts → Bob decrypts', function () {
            const alice = keypair(), bob = keypair();
            const secretA = msg.deriveSharedSecret(alice.wif, msg.generateSessionKey(bob.wif).publicKey).sharedSecret;
            const secretB = msg.deriveSharedSecret(bob.wif, msg.generateSessionKey(alice.wif).publicKey).sharedSecret;
            const { ciphertext } = msg.sessionEncrypt('see you at noon', secretA);
            expect(msg.sessionDecrypt(ciphertext, secretB).plaintext).to.equal('see you at noon');
        });

        it('a different shared secret cannot decrypt', function () {
            const secret = crypto.randomBytes(32);
            const other = crypto.randomBytes(32);
            const { ciphertext } = msg.sessionEncrypt('hi', secret);
            expectCode(() => msg.sessionDecrypt(ciphertext, other), 'DECRYPTION_FAILED');
        });

        it('requires a valid WIF and the other pubkey', function () {
            const a = keypair();
            expectCode(() => msg.generateSessionKey('bad'), 'INVALID_WIF');
            expectCode(() => msg.deriveSharedSecret(a.wif, null), 'INVALID_PUBKEY');
        });
    });
});
