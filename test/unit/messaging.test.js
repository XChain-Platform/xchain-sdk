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
const MessagingUtils = require('../../src/actions/messaging.js');
const WalletUtils = require('../../src/utils/wallet.js');

// Real secp256k1 keypairs (no stubbing) so these exercise the actual
// ECIES / ECDH / AES-GCM primitives end-to-end.
const NETWORK = 'bitcoin-regtest';
function keypair() { return new WalletUtils(NETWORK).generateKeyPair(); }

// Assert a thrown SDKMessagingError carries the expected `.code`.
function expectCode(fn, code) {
    expect(fn).to.throw().with.property('code', code);
}

// ECIES (method 1): string payloads
describe('MessagingUtils @crypto @regression', function () {

    let msg;
    beforeEach(function () { msg = new MessagingUtils(NETWORK); });

    describe('ECIES (string)', function () {

        it('round-trips a plaintext message', function () {
            const bob = keypair();
            const { ciphertext } = msg.eciesEncrypt('hello world', bob.publicKeyHex);
            expect(msg.eciesDecrypt(ciphertext, bob.wif).plaintext).to.equal('hello world');
        });

        it('accepts the recipient pubkey as a Buffer', function () {
            const bob = keypair();
            const { ciphertext } = msg.eciesEncrypt('via buffer', bob.publicKey);
            expect(msg.eciesDecrypt(ciphertext, bob.wif).plaintext).to.equal('via buffer');
        });

        it('produces fresh ciphertext per call (ephemeral key + random IV) but decrypts equal', function () {
            const bob = keypair();
            const c1 = msg.eciesEncrypt('same', bob.publicKeyHex).ciphertext;
            const c2 = msg.eciesEncrypt('same', bob.publicKeyHex).ciphertext;
            expect(c1).to.not.equal(c2);
            expect(msg.eciesDecrypt(c1, bob.wif).plaintext).to.equal('same');
            expect(msg.eciesDecrypt(c2, bob.wif).plaintext).to.equal('same');
        });

        it('carries the documented overhead plus a 1-byte v1 version prefix (GCM is length-preserving)', function () {
            const bob = keypair();
            const { ciphertext } = msg.eciesEncrypt('A', bob.publicKeyHex); // 1-byte plaintext
            // v1 layout: version(1) + ephemeralPubkey(33) + iv(12) + authTag(16) + data
            expect(Buffer.from(ciphertext, 'hex').length).to.equal(1 + 33 + 12 + 16 + 1);
            expect(Buffer.from(ciphertext, 'hex')[0]).to.equal(1); // KDF_VERSION_V1
        });

        it('cannot be decrypted with the wrong private key', function () {
            const bob = keypair(), eve = keypair();
            const { ciphertext } = msg.eciesEncrypt('secret', bob.publicKeyHex);
            expectCode(() => msg.eciesDecrypt(ciphertext, eve.wif), 'DECRYPTION_FAILED');
        });

        it('detects a flipped ciphertext byte (GCM auth tag)', function () {
            const bob = keypair();
            const buf = Buffer.from(msg.eciesEncrypt('secret', bob.publicKeyHex).ciphertext, 'hex');
            buf[buf.length - 1] ^= 0xff;
            expectCode(() => msg.eciesDecrypt(buf.toString('hex'), bob.wif), 'DECRYPTION_FAILED');
        });
    });
});

describe('MessagingUtils @crypto @regression', function () {

    let msg;
    beforeEach(function () { msg = new MessagingUtils(NETWORK); });

    describe('ECIES (string)', function () {

        it('rejects a crafted ciphertext whose ephemeral point is off-curve (invalid-curve guard)', function () {
            const bob = keypair();
            const buf = Buffer.from(msg.eciesEncrypt('secret', bob.publicKeyHex).ciphertext, 'hex');
            // v1 layout: [version(1)][ephemeralPubkey(33)][iv(12)][authTag(16)][data].
            // Overwrite the ephemeral pubkey with a compressed-looking non-point
            // (prefix 0x02, x = 0xff..ff > field modulus). It must be rejected as an
            // invalid ciphertext BEFORE reaching the ECDH, not surface as a generic
            // GCM failure (and never touch our private key via an unchecked point).
            buf.fill(0xff, 1, 1 + 33);
            buf[1] = 0x02;
            expectCode(() => msg.eciesDecrypt(buf.toString('hex'), bob.wif), 'INVALID_CIPHERTEXT');
        });

        it('rejects empty plaintext, missing/short pubkey, short ciphertext, bad WIF', function () {
            const bob = keypair();
            expectCode(() => msg.eciesEncrypt('', bob.publicKeyHex), 'INVALID_MESSAGE');
            expectCode(() => msg.eciesEncrypt('m', null), 'INVALID_PUBKEY');
            expectCode(() => msg.eciesEncrypt('m', Buffer.alloc(20)), 'INVALID_PUBKEY');
            const ok = msg.eciesEncrypt('m', bob.publicKeyHex).ciphertext;
            expectCode(() => msg.eciesDecrypt('00', bob.wif), 'INVALID_CIPHERTEXT');
            expectCode(() => msg.eciesDecrypt(ok, 'not-a-wif'), 'INVALID_WIF');
        });

        it('rejects a 65-byte uncompressed pubkey as an invalid point (delegated to Node crypto)', function () {
            // A 65-byte buffer passes the SDK length check but is not a valid secp256k1 point;
            // Node's ECDH layer throws, so any error propagating out is the expected outcome.
            const badPubkey = Buffer.alloc(65, 0x02);
            expect(() => msg.eciesEncrypt('hello', badPubkey)).to.throw();
        });

        it('uses a distinct IV per encrypt call (nonce uniqueness)', function () {
            const bob = keypair();
            // v1 eciesEncrypt packs: version(1) + ephemeralPubkey(33) + iv(12) + authTag(16) + encrypted
            const VERSION_LEN = 1, EPHEMERAL_LEN = 33, IV_LEN = 12;
            const IV_OFFSET = VERSION_LEN + EPHEMERAL_LEN;
            const c1 = Buffer.from(msg.eciesEncrypt('same', bob.publicKeyHex).ciphertext, 'hex');
            const c2 = Buffer.from(msg.eciesEncrypt('same', bob.publicKeyHex).ciphertext, 'hex');
            const iv1 = c1.subarray(IV_OFFSET, IV_OFFSET + IV_LEN).toString('hex');
            const iv2 = c2.subarray(IV_OFFSET, IV_OFFSET + IV_LEN).toString('hex');
            expect(iv1).to.not.equal(iv2);
        });
    });
});
