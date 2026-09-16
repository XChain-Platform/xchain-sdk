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
const MessagingUtils = require('../../../../src/actions/messaging.js');
const WalletUtils = require('../../../../src/utils/wallet.js');

// Real secp256k1 keypairs (no stubbing) so these exercise the actual
// ECIES / ECDH / AES-GCM primitives end-to-end.
const NETWORK = 'bitcoin-regtest';
function keypair() { return new WalletUtils(NETWORK).generateKeyPair(); }

// Assert a thrown SDKMessagingError carries the expected `.code`.
function expectCode(fn, code) {
    expect(fn).to.throw().with.property('code', code);
}

// KDF versioning + cross-method domain separation: one ECDH secret must
// never produce the same encryption key in two different methods.
describe('MessagingUtils @crypto @regression', function () {

    let msg;
    beforeEach(function () { msg = new MessagingUtils(NETWORK); });

    describe('KDF v1 (HKDF-SHA256) versioning and domain separation', function () {

        // Browser crypto shims in wallet shells do not expose crypto.hkdfSync.
        // Calling it throws "crypto2.hkdfSync is not a function" and kills every
        // v1 encrypt and decrypt outside Node, including messaging in the app.
        // RFC 5869 over createHmac is available in those shims.
        // This pins the two to the same bytes wherever the builtin exists: a
        // key derived in the browser and one derived in Node MUST agree, or a
        // message encrypted in one cannot be read in the other.
        it('[REGRESSION] derives byte-identically to the Node crypto.hkdfSync builtin', function () {
            if (typeof crypto.hkdfSync !== 'function') this.skip();
            const alice = keypair(), bob = keypair();
            const product = msg.ecdhProduct(alice.privateKey, bob.publicKey);
            const cases = [
                ['xchain-messaging-kdf-v1', 'xchain-ecies-v1', 32],
                ['xchain-messaging-kdf-v1', 'xchain-ecdh-session-v1', 32],
                ['salt', 'info', 64],   // multi-block expand
                ['', '', 16],           // empty salt/info, truncated output
            ];
            for (const [salt, info, len] of cases) {
                const builtin = Buffer.from(crypto.hkdfSync(
                    'sha256', product, Buffer.from(salt, 'utf8'), Buffer.from(info, 'utf8'), len,
                ));
                const ours = msg.hkdfSha256Test(
                    product, Buffer.from(salt, 'utf8'), Buffer.from(info, 'utf8'), len,
                );
                expect(ours.length).to.equal(len);
                expect(ours.toString('hex')).to.equal(builtin.toString('hex'));
            }
        });

        it('[REGRESSION] the derivation does not depend on crypto.hkdfSync being present', function () {
            // Simulates the browser shim: with the builtin removed, the ECIES
            // key must still derive rather than throwing.
            const original = crypto.hkdfSync;
            // eslint-disable-next-line no-undefined
            crypto.hkdfSync = undefined;
            try {
                const alice = keypair(), bob = keypair();
                const key = msg.deriveEciesKey(alice.privateKey, bob.publicKey);
                expect(Buffer.isBuffer(key)).to.equal(true);
                expect(key.length).to.equal(32);
            } finally {
                crypto.hkdfSync = original;
            }
        });
    });
});

describe('MessagingUtils @crypto @regression', function () {

    let msg;
    beforeEach(function () { msg = new MessagingUtils(NETWORK); });

    describe('KDF v1 (HKDF-SHA256) versioning and domain separation', function () {

        it('domain separation: same ECDH product derives DIFFERENT keys under ECIES vs ECDH-session', function () {
            // Identical private/public pair feeds both per-method derivations.
            // The distinct HKDF `info` labels MUST yield different keys.
            const alice = keypair(), bob = keypair();
            const priv = alice.privateKey;
            const pub  = bob.publicKey;

            const eciesKey = msg.deriveEciesKey(priv, pub);
            const ecdhKey  = msg.deriveEcdhSessionKey(priv, pub);

            expect(Buffer.isBuffer(eciesKey)).to.equal(true);
            expect(eciesKey.length).to.equal(32);
            expect(ecdhKey.length).to.equal(32);
            // Same ECDH product, different info label => different key.
            expect(eciesKey.equals(ecdhKey)).to.equal(false);
            // And both differ from the legacy bare-SHA256 derivation.
            const legacy = msg.deriveECDHSecretLegacy(priv, pub);
            expect(eciesKey.equals(legacy)).to.equal(false);
            expect(ecdhKey.equals(legacy)).to.equal(false);
        });

        it('emits v1-framed ECIES ciphertext (leading 0x01 version byte) and round-trips', function () {
            const bob = keypair();
            const { ciphertext } = msg.eciesEncrypt('v1 round trip', bob.publicKeyHex);
            expect(Buffer.from(ciphertext, 'hex')[0]).to.equal(1); // KDF_VERSION_V1
            expect(msg.eciesDecrypt(ciphertext, bob.wif).plaintext).to.equal('v1 round trip');
        });

        it('still decrypts a legacy (v0, no version byte, bare-SHA256) ECIES blob', function () {
            // Build a legacy blob by hand: [ephemeralPubkey(33)][iv][authTag][data]
            // keyed by SHA256(raw ecdh product), exactly the legacy layout.
            const bob = keypair();
            const ephemeral = keypair();
            const legacyKey = msg.deriveECDHSecretLegacy(ephemeral.privateKey, bob.publicKey);
            const iv = crypto.randomBytes(12);
            const cipher = crypto.createCipheriv('aes-256-gcm', legacyKey, iv);
            const enc = Buffer.concat([cipher.update('legacy hi', 'utf8'), cipher.final()]);
            const tag = cipher.getAuthTag();
            const legacyBlob = Buffer.concat([ephemeral.publicKey, iv, tag, enc]);
            // Leading byte is 0x02/0x03 (compressed pubkey), so it is sniffed as v0.
            expect([2, 3]).to.include(legacyBlob[0]);
            expect(msg.eciesDecrypt(legacyBlob.toString('hex'), bob.wif).plaintext).to.equal('legacy hi');
        });
    });
});

describe('MessagingUtils @crypto @regression', function () {

    let msg;
    beforeEach(function () { msg = new MessagingUtils(NETWORK); });

    describe('KDF v1 (HKDF-SHA256) versioning and domain separation', function () {

        it('round-trips a legacy v0 binary (bytes) ECIES blob', function () {
            const bob = keypair();
            const ephemeral = keypair();
            const legacyKey = msg.deriveECDHSecretLegacy(ephemeral.privateKey, bob.publicKey);
            const payload = crypto.randomBytes(33);
            const iv = crypto.randomBytes(12);
            const cipher = crypto.createCipheriv('aes-256-gcm', legacyKey, iv);
            const enc = Buffer.concat([cipher.update(payload), cipher.final()]);
            const tag = cipher.getAuthTag();
            const legacyBlob = Buffer.concat([ephemeral.publicKey, iv, tag, enc]);
            expect(msg.eciesDecryptBytes(legacyBlob.toString('hex'), bob.wif).plaintext.equals(payload)).to.equal(true);
        });

        it('deriveSharedSecret defaults to v1 HKDF and exposes the legacy secret via {legacy:true}', function () {
            const alice = keypair(), bob = keypair();
            const bPub = msg.generateSessionKey(bob.wif).publicKey;
            const v1 = msg.deriveSharedSecret(alice.wif, bPub).sharedSecret;
            const legacy = msg.deriveSharedSecret(alice.wif, bPub, { legacy: true }).sharedSecret;
            expect(v1).to.not.equal(legacy);
            // v1 is symmetric (both parties agree) under the ECDH-session label.
            const aPub = msg.generateSessionKey(alice.wif).publicKey;
            const v1Other = msg.deriveSharedSecret(bob.wif, aPub).sharedSecret;
            expect(v1).to.equal(v1Other);
        });
    });
});
