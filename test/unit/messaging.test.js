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
const MessagingUtils = require('../../src/messaging.js');
const WalletUtils = require('../../src/wallet.js');

// Real secp256k1 keypairs (no stubbing) so these exercise the actual
// ECIES / ECDH / AES-GCM primitives end-to-end.
const NETWORK = 'bitcoin-regtest';
function keypair() { return new WalletUtils(NETWORK).generateKeyPair(); }

// Assert a thrown SDKMessagingError carries the expected `.code`.
function expectCode(fn, code) {
    expect(fn).to.throw().with.property('code', code);
}

describe('MessagingUtils @crypto @regression', function () {

    let msg;
    beforeEach(function () { msg = new MessagingUtils(NETWORK); });

    // -----------------------------------------------------------------------
    //  ECIES (method 1): string payloads
    // -----------------------------------------------------------------------
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

    // -----------------------------------------------------------------------
    //  ECIES (method 1): binary payloads (gated-content key handoff)
    // -----------------------------------------------------------------------
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

    // -----------------------------------------------------------------------
    //  ECDH (method 2): session communication
    // -----------------------------------------------------------------------
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

    // -----------------------------------------------------------------------
    //  KDF versioning + cross-method domain separation (fix #3520)
    // -----------------------------------------------------------------------
    describe('KDF v1 (HKDF-SHA256) versioning and domain separation', function () {

        // : the derivation used to call crypto.hkdfSync, which does not
        // exist in the browser crypto shims the wallet shells build against -
        // it threw "crypto2.hkdfSync is not a function" and killed every v1
        // encrypt and decrypt outside Node, i.e. messaging in the whole app.
        // It is now RFC 5869 over createHmac, which those shims do provide.
        // This pins the two to the same bytes wherever the builtin exists: a
        // key derived in the browser and one derived in Node MUST agree, or a
        // message encrypted in one cannot be read in the other.
        it('[REGRESSION] derives byte-identically to the Node crypto.hkdfSync builtin', function () {
            if (typeof crypto.hkdfSync !== 'function') this.skip();
            const alice = keypair(), bob = keypair();
            const product = msg._ecdhProduct(alice.privateKey, bob.publicKey);
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
                const ours = msg._hkdfSha256Test(
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
                const key = msg._deriveEciesKey(alice.privateKey, bob.publicKey);
                expect(Buffer.isBuffer(key)).to.equal(true);
                expect(key.length).to.equal(32);
            } finally {
                crypto.hkdfSync = original;
            }
        });

        it('domain separation: same ECDH product derives DIFFERENT keys under ECIES vs ECDH-session', function () {
            // Identical private/public pair feeds both per-method derivations.
            // The distinct HKDF `info` labels MUST yield different keys.
            const alice = keypair(), bob = keypair();
            const priv = alice.privateKey;
            const pub  = bob.publicKey;

            const eciesKey = msg._deriveEciesKey(priv, pub);
            const ecdhKey  = msg._deriveEcdhSessionKey(priv, pub);

            expect(Buffer.isBuffer(eciesKey)).to.equal(true);
            expect(eciesKey.length).to.equal(32);
            expect(ecdhKey.length).to.equal(32);
            // Same ECDH product, different info label => different key.
            expect(eciesKey.equals(ecdhKey)).to.equal(false);
            // And both differ from the legacy bare-SHA256 derivation.
            const legacy = msg._deriveECDHSecretLegacy(priv, pub);
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
            // keyed by SHA256(raw ecdh product), exactly the pre-#3520 layout.
            const bob = keypair();
            const ephemeral = keypair();
            const legacyKey = msg._deriveECDHSecretLegacy(ephemeral.privateKey, bob.publicKey);
            const iv = crypto.randomBytes(12);
            const cipher = crypto.createCipheriv('aes-256-gcm', legacyKey, iv);
            const enc = Buffer.concat([cipher.update('legacy hi', 'utf8'), cipher.final()]);
            const tag = cipher.getAuthTag();
            const legacyBlob = Buffer.concat([ephemeral.publicKey, iv, tag, enc]);
            // Leading byte is 0x02/0x03 (compressed pubkey), so it is sniffed as v0.
            expect([2, 3]).to.include(legacyBlob[0]);
            expect(msg.eciesDecrypt(legacyBlob.toString('hex'), bob.wif).plaintext).to.equal('legacy hi');
        });

        it('round-trips a legacy v0 binary (bytes) ECIES blob', function () {
            const bob = keypair();
            const ephemeral = keypair();
            const legacyKey = msg._deriveECDHSecretLegacy(ephemeral.privateKey, bob.publicKey);
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

    // -----------------------------------------------------------------------
    //  AES (method 3): pre-shared key
    // -----------------------------------------------------------------------
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

    // -----------------------------------------------------------------------
    //  High-level getMessages(): decryption integration
    // -----------------------------------------------------------------------
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

    describe('getMessages()', function () {

        function explorerReturning(rows, captured) {
            return { getMessages: async (address, queryType, opts) => {
                if (captured) { captured.address = address; captured.queryType = queryType; captured.opts = opts; }
                return rows;
            } };
        }

        it('passes plaintext messages through untouched', async function () {
            const explorer = explorerReturning([
                { source: 'A', destination: 'B', plaintext_message: 'open msg', tx_hash: 't', block_index: 1 }
            ]);
            const out = await msg.getMessages('B', { type: 'received' }, explorer);
            expect(out).to.have.length(1);
            expect(out[0].text).to.equal('open msg');
            expect(out[0].encrypted).to.equal(false);
        });

        // : the doubles above return a BARE ARRAY, but a real explorer
        // serves `{ data: [...], total }` and the client hands that body back
        // untouched. Requiring an array meant every live response was discarded
        // and the inbox came back empty - an on-chain, valid MESSAGE addressed
        // to you was invisible in the wallet, with no error anywhere. Found by
        // sending a real regtest message that never arrived.
        it('[REGRESSION] reads the live explorer envelope { data: [...] }, not just a bare array', async function () {
            const explorer = explorerReturning({
                total: 1,
                data: [
                    { source: 'A', destination: 'B', plaintext_message: 'open msg', tx_hash: 't', block_index: 1 }
                ],
            });
            const out = await msg.getMessages('B', { type: 'received' }, explorer);
            expect(out).to.have.length(1);
            expect(out[0].text).to.equal('open msg');
        });

        it('[REGRESSION] still returns [] for a response that carries no rows either way', async function () {
            expect(await msg.getMessages('B', { type: 'received' }, explorerReturning({ total: 0, data: [] })))
                .to.have.length(0);
            expect(await msg.getMessages('B', { type: 'received' }, explorerReturning(null)))
                .to.have.length(0);
            expect(await msg.getMessages('B', { type: 'received' }, explorerReturning({ error: 'nope' })))
                .to.have.length(0);
        });

        it('decrypts a method-less v2 ECIES message (inferred method) when a wif is supplied', async function () {
            // A real MESSAGE v2 row carries ENCRYPTED_MESSAGE but no ENCRYPTION_METHOD
            // on the wire: getMessages must infer ECIES (1) and decrypt. (No fabricated
            // encryption_method here, so this exercises the real inferred-method path.)
            const bob = keypair();
            const { ciphertext } = msg.eciesEncrypt('hi bob', bob.publicKeyHex);
            const explorer = explorerReturning([
                { source: 'A', destination: 'B', encrypted_message: ciphertext, tx_hash: 't', block_index: 7 }
            ]);
            const out = await msg.getMessages('B', { wif: bob.wif, type: 'received' }, explorer);
            expect(out[0].method).to.equal(1);
            expect(out[0].text).to.equal('hi bob');
            expect(out[0].encrypted).to.equal(true);
            expect(Buffer.isBuffer(out[0].bytes)).to.equal(true);
        });

        it('decrypts an indexer-stamped v2 ECIES message (explicit encryption_method=1)', async function () {
            // After indexing, v2 rows persist encryption_method=1; confirm the explicit
            // value path decrypts identically to the inferred path above.
            const bob = keypair();
            const { ciphertext } = msg.eciesEncrypt('hi bob', bob.publicKeyHex);
            const explorer = explorerReturning([
                { source: 'A', destination: 'B', encryption_method: 1, encrypted_message: ciphertext, tx_hash: 't', block_index: 7 }
            ]);
            const out = await msg.getMessages('B', { wif: bob.wif, type: 'received' }, explorer);
            expect(out[0].text).to.equal('hi bob');
            expect(Buffer.isBuffer(out[0].bytes)).to.equal(true);
        });

        it('leaves text null (no throw) when decryption fails with the wrong wif', async function () {
            const bob = keypair(), eve = keypair();
            const { ciphertext } = msg.eciesEncrypt('hi bob', bob.publicKeyHex);
            const explorer = explorerReturning([
                { source: 'A', destination: 'B', encryption_method: 1, encrypted_message: ciphertext, tx_hash: 't', block_index: 7 }
            ]);
            const out = await msg.getMessages('B', { wif: eve.wif }, explorer);
            expect(out[0].text).to.equal(null);
            expect(out[0].encrypted).to.equal(true);
        });

        it('decrypts an ECDH (method 2) payload via the counterparty pubkey and labels it method 2', async function () {
            // ECDH payloads are byte-identical to ECIES on the wire (no method/key),
            // so getMessages falls back to an ECDH session decrypt using the
            // counterparty's address pubkey resolved via explorer.getPublicKey.
            const alice = keypair(), bob = keypair();
            const secret = msg.deriveSharedSecret(alice.wif, bob.publicKeyHex).sharedSecret;
            const { ciphertext } = msg.sessionEncrypt('ecdh hello', secret);
            const explorer = {
                getMessages: async () => ([
                    { source: 'A', destination: 'B', encrypted_message: ciphertext, tx_hash: 't', block_index: 7 },
                ]),
                getPublicKey: async (addr) => (addr === 'A' ? { pubkey: alice.publicKeyHex } : null),
            };
            const out = await msg.getMessages('B', { wif: bob.wif, type: 'received' }, explorer);
            expect(out[0].text).to.equal('ecdh hello');
            expect(out[0].method).to.equal(2);
            expect(out[0].encrypted).to.equal(true);
        });

        it('prefers ECIES and does not relabel when the message is plain ECIES', async function () {
            const alice = keypair(), bob = keypair();
            const { ciphertext } = msg.eciesEncrypt('plain ecies', bob.publicKeyHex);
            const explorer = {
                getMessages: async () => ([
                    { source: 'A', destination: 'B', encrypted_message: ciphertext, tx_hash: 't', block_index: 7 },
                ]),
                getPublicKey: async () => ({ pubkey: alice.publicKeyHex }),
            };
            const out = await msg.getMessages('B', { wif: bob.wif, type: 'received' }, explorer);
            expect(out[0].text).to.equal('plain ecies');
            expect(out[0].method).to.equal(1);
        });

        it('leaves an AES (method 3) payload locked (no key, no false decrypt)', async function () {
            const alice = keypair(), bob = keypair();
            const sharedKey = crypto.randomBytes(32).toString('hex');
            const { ciphertext } = msg.aesEncrypt('aes secret', sharedKey);
            const explorer = {
                getMessages: async () => ([
                    { source: 'A', destination: 'B', encrypted_message: ciphertext, tx_hash: 't', block_index: 7 },
                ]),
                getPublicKey: async (addr) => (addr === 'A' ? { pubkey: alice.publicKeyHex } : null),
            };
            const out = await msg.getMessages('B', { wif: bob.wif, type: 'received' }, explorer);
            expect(out[0].text).to.equal(null);
            expect(out[0].encrypted).to.equal(true);
        });

        it('surfaces encryptionKey and format on returned entries (handshake rows)', async function () {
            const explorer = explorerReturning([
                { source: 'A', destination: 'B', action_format: 0, encryption_method: 2, encryption_key: 'deadbeef', tx_hash: 't', block_index: 7 },
            ]);
            const out = await msg.getMessages('B', { type: 'received' }, explorer);
            expect(out[0].encryptionKey).to.equal('deadbeef');
            expect(out[0].format).to.equal(0);
            expect(out[0].method).to.equal(2);
        });

        it('maps type → queryType (sent→source, received→destination, all→address)', async function () {
            const cap = {};
            const explorer = explorerReturning([], cap);
            await msg.getMessages('B', { type: 'sent' }, explorer);   expect(cap.queryType).to.equal('source');
            await msg.getMessages('B', { type: 'received' }, explorer); expect(cap.queryType).to.equal('destination');
            await msg.getMessages('B', {}, explorer);                  expect(cap.queryType).to.equal('address');
        });

        it('returns [] when the explorer yields no array, and validates inputs', async function () {
            const explorer = explorerReturning(null);
            expect(await msg.getMessages('B', {}, explorer)).to.deep.equal([]);
            await msg.getMessages('B', {}, null).then(() => { throw new Error('should throw'); }, e => expect(e.code).to.equal('EXPLORER_REQUIRED'));
        });
    });

    describe('getAllMessages()', function () {

        it('merges across explorers and sorts by block descending', async function () {
            const e1 = { getMessages: async () => ([{ source: 'A', destination: 'B', plaintext_message: 'old', block_index: 2 }]) };
            const e2 = { getMessages: async () => ([{ source: 'A', destination: 'B', plaintext_message: 'new', block_index: 9 }]) };
            const out = await msg.getAllMessages('B', {}, [{ explorer: e1, chain: 'BTC' }, { explorer: e2, chain: 'LTC' }]);
            expect(out.map(m => m.block)).to.deep.equal([9, 2]);
        });

        it('skips an explorer that throws', async function () {
            const ok = { getMessages: async () => ([{ source: 'A', destination: 'B', plaintext_message: 'ok', block_index: 1 }]) };
            const bad = { getMessages: async () => { throw new Error('down'); } };
            const out = await msg.getAllMessages('B', {}, [{ explorer: ok, chain: 'BTC' }, { explorer: bad, chain: 'LTC' }]);
            expect(out).to.have.length(1);
            expect(out[0].text).to.equal('ok');
        });

        it('throws EXPLORER_REQUIRED when explorers is empty array', async function () {
            await msg.getAllMessages('B', {}, []).then(() => { throw new Error('should throw'); }, e => expect(e.code).to.equal('EXPLORER_REQUIRED'));
        });

        it('throws EXPLORER_REQUIRED when explorers is not an array', async function () {
            await msg.getAllMessages('B', {}, null).then(() => { throw new Error('should throw'); }, e => expect(e.code).to.equal('EXPLORER_REQUIRED'));
        });
    });

    // -----------------------------------------------------------------------
    //  ECIES binary: error paths
    // -----------------------------------------------------------------------
    describe('ECIES bytes: additional error paths', function () {

        it('throws INVALID_WIF on bad WIF in eciesDecryptBytes', function () {
            const { ciphertext } = msg.eciesEncryptBytes(Buffer.from('hello'), keypair().publicKeyHex);
            expectCode(() => msg.eciesDecryptBytes(ciphertext, 'bad-wif'), 'INVALID_WIF');
        });

        it('accepts Buffer ciphertext in eciesDecryptBytes', function () {
            const bob = keypair();
            const payload = Buffer.from([1, 2, 3, 4]);
            const { ciphertext } = msg.eciesEncryptBytes(payload, bob.publicKeyHex);
            const buf = Buffer.from(ciphertext, 'hex');
            const { plaintext } = msg.eciesDecryptBytes(buf, bob.wif);
            expect(plaintext.equals(payload)).to.equal(true);
        });
    });

    // -----------------------------------------------------------------------
    //  deriveSharedSecret(): error paths
    // -----------------------------------------------------------------------
    describe('deriveSharedSecret(): error paths', function () {

        it('throws INVALID_WIF on bad WIF', function () {
            const alice = keypair();
            expectCode(() => msg.deriveSharedSecret('bad-wif', alice.publicKeyHex), 'INVALID_WIF');
        });

        it('accepts Buffer for theirPublicKey', function () {
            const alice = keypair(), bob = keypair();
            const s = msg.deriveSharedSecret(alice.wif, bob.publicKey);
            expect(Buffer.from(s.sharedSecret, 'hex').length).to.equal(32);
        });
    });

    // -----------------------------------------------------------------------
    //  getPublicKey()
    // -----------------------------------------------------------------------
    describe('getPublicKey()', function () {

        it('throws INVALID_ADDRESS for missing address', async function () {
            const explorer = { getPublicKey: async () => ({ pubkey: '03abc' }) };
            await msg.getPublicKey('', explorer).then(() => { throw new Error('should throw'); }, e => expect(e.code).to.equal('INVALID_ADDRESS'));
            await msg.getPublicKey(null, explorer).then(() => { throw new Error('should throw'); }, e => expect(e.code).to.equal('INVALID_ADDRESS'));
        });

        it('throws EXPLORER_REQUIRED when explorer is missing', async function () {
            await msg.getPublicKey('addr1', null).then(() => { throw new Error('should throw'); }, e => expect(e.code).to.equal('EXPLORER_REQUIRED'));
        });

        it('returns the pubkey when explorer resolves {pubkey}', async function () {
            const explorer = { getPublicKey: async (addr) => ({ pubkey: '03deadbeef' }) };
            const result = await msg.getPublicKey('addr1', explorer);
            expect(result).to.equal('03deadbeef');
        });

        it('returns null when explorer resolves without pubkey', async function () {
            const explorer = { getPublicKey: async () => ({}) };
            const result = await msg.getPublicKey('addr1', explorer);
            expect(result).to.be.null;
        });

        it('returns null when explorer resolves null', async function () {
            const explorer = { getPublicKey: async () => null };
            const result = await msg.getPublicKey('addr1', explorer);
            expect(result).to.be.null;
        });
    });

    // -----------------------------------------------------------------------
    //  getMessages(): encrypted_message without wif (sets encrypted=true)
    // -----------------------------------------------------------------------
    describe('getMessages(): encrypted without wif', function () {

        it('marks entry encrypted=true and leaves text=null when encrypted_message present but no wif', async function () {
            const explorer = { getMessages: async () => ([
                { source: 'A', destination: 'B', encryption_method: 1, encrypted_message: 'aabbcc', tx_hash: 'tx', block_index: 5 }
            ]) };
            // No wif in opts: should hit the `else if (msg.encrypted_message)` branch
            const out = await msg.getMessages('B', {}, explorer);
            expect(out).to.have.length(1);
            expect(out[0].encrypted).to.equal(true);
            expect(out[0].text).to.be.null;
            expect(out[0].bytes).to.be.null;
        });

        it('exposes coin/chain/block/txid fields from raw message', async function () {
            // The explorer /messages contract emits the block time under
            // `timestamp` (db.js aliases `b1.block_time as timestamp`), so the
            // stub row mirrors the real producer shape.
            const explorer = { getMessages: async () => ([
                { source: 'S', destination: 'D', coin: 'BTC', plaintext_message: 'hi', tx_hash: 'txabc', block_index: 10, timestamp: 1700000000 }
            ]) };
            const out = await msg.getMessages('D', {}, explorer);
            expect(out[0].coin).to.equal('BTC');
            expect(out[0].txid).to.equal('txabc');
            expect(out[0].block).to.equal(10);
            expect(out[0].timestamp).to.equal(1700000000);
        });

        it('falls back to a raw block_time column when no timestamp alias is present', async function () {
            const explorer = { getMessages: async () => ([
                { source: 'S', destination: 'D', plaintext_message: 'hi', block_time: 1700000001 }
            ]) };
            const out = await msg.getMessages('D', {}, explorer);
            expect(out[0].timestamp).to.equal(1700000001);
        });

        it('passes limit/page/sortorder options to explorer.getMessages', async function () {
            const captured = {};
            const explorer = { getMessages: async (addr, qtype, opts) => { Object.assign(captured, opts); return []; } };
            await msg.getMessages('B', { limit: 10, page: 2, sortorder: 'asc' }, explorer);
            expect(captured.limit).to.equal(10);
            expect(captured.page).to.equal(2);
            expect(captured.sortorder).to.equal('asc');
        });

        it('maps absent fields to null (from/to/coin/txid/block/timestamp)', async function () {
            // Message with no source/destination/coin/tx_hash/block_index/block_time
            const explorer = { getMessages: async () => ([
                { plaintext_message: 'sparse' }
            ]) };
            const out = await msg.getMessages('B', {}, explorer);
            expect(out[0].from).to.be.null;
            expect(out[0].to).to.be.null;
            expect(out[0].coin).to.be.null;
            expect(out[0].txid).to.be.null;
            expect(out[0].block).to.be.null;
            expect(out[0].timestamp).to.be.null;
            expect(out[0].method).to.be.null;
        });
    });

    // -----------------------------------------------------------------------
    //  send(): validation guards (does not need real network calls)
    // -----------------------------------------------------------------------
    describe('send(): validation guards', function () {

        it('throws INVALID_WIF when wif is missing', async function () {
            await msg.send({ coin: 'BTC', destination: 'addr', message: 'hi', encoder: {} }, {})
                .then(() => { throw new Error('should throw'); }, e => expect(e.code).to.equal('INVALID_WIF'));
        });

        it('throws INVALID_COIN when coin is missing', async function () {
            await msg.send({ wif: 'wif', destination: 'addr', message: 'hi', encoder: {} }, {})
                .then(() => { throw new Error('should throw'); }, e => expect(e.code).to.equal('INVALID_COIN'));
        });

        it('throws INVALID_DESTINATION when destination is missing', async function () {
            await msg.send({ wif: 'wif', coin: 'BTC', message: 'hi', encoder: {} }, {})
                .then(() => { throw new Error('should throw'); }, e => expect(e.code).to.equal('INVALID_DESTINATION'));
        });

        it('throws INVALID_MESSAGE for empty string message', async function () {
            await msg.send({ wif: 'wif', coin: 'BTC', destination: 'addr', message: '', encoder: {} }, {})
                .then(() => { throw new Error('should throw'); }, e => expect(e.code).to.equal('INVALID_MESSAGE'));
        });

        it('throws INVALID_MESSAGE for null message', async function () {
            await msg.send({ wif: 'wif', coin: 'BTC', destination: 'addr', message: null, encoder: {} }, {})
                .then(() => { throw new Error('should throw'); }, e => expect(e.code).to.equal('INVALID_MESSAGE'));
        });

        it('throws INVALID_MESSAGE for empty Buffer message', async function () {
            await msg.send({ wif: 'wif', coin: 'BTC', destination: 'addr', message: Buffer.alloc(0), encoder: {} }, {})
                .then(() => { throw new Error('should throw'); }, e => expect(e.code).to.equal('INVALID_MESSAGE'));
        });

        it('throws ENCODER_REQUIRED when encoder is missing', async function () {
            await msg.send({ wif: 'wif', coin: 'BTC', destination: 'addr', message: 'hi' }, {})
                .then(() => { throw new Error('should throw'); }, e => expect(e.code).to.equal('ENCODER_REQUIRED'));
        });

        it('throws SDK_REQUIRED when sdk is missing', async function () {
            await msg.send({ wif: 'wif', coin: 'BTC', destination: 'addr', message: 'hi', encoder: {} })
                .then(() => { throw new Error('should throw'); }, e => expect(e.code).to.equal('SDK_REQUIRED'));
        });

        it('throws INVALID_METHOD for unknown method number', async function () {
            const fakeSdk = { _requireExplorer: () => ({ getPublicKey: async () => null }) };
            await msg.send({ wif: 'wif', coin: 'BTC', destination: 'addr', message: 'hi', encoder: {}, method: 99 }, fakeSdk)
                .then(() => { throw new Error('should throw'); }, e => expect(e.code).to.equal('INVALID_METHOD'));
        });

        it('throws INVALID_MESSAGE for binary payload with plaintext method (null)', async function () {
            await msg.send({ wif: 'wif', coin: 'BTC', destination: 'addr', message: Buffer.from('x'), encoder: {}, method: null }, {})
                .then(() => { throw new Error('should throw'); }, e => expect(e.code).to.equal('INVALID_MESSAGE'));
        });

        it('encrypts a binary payload with ECDH method (round-trips via sessionDecryptBytes)', async function () {
            const crypto = require('crypto');
            const secret = crypto.randomBytes(32).toString('hex');
            const payload = crypto.randomBytes(33);
            let sentParams = null;
            const fakeSdk = {
                createAction: async (data) => { sentParams = data.params; return { psbt: 'p', actionString: 'XC|MSG' }; },
                wallet: {
                    signPsbt:    () => ({ txHex: 'txhex', txid: 'txecdhbin' }),
                    broadcastTx: async () => ({})
                },
                _requireEncoder: () => ({}),
            };
            const result = await msg.send(
                { wif: 'wif', coin: 'BTC', destination: 'addr', message: payload, encoder: {}, method: 2, sharedSecret: secret },
                fakeSdk
            );
            expect(result.txid).to.equal('txecdhbin');
            const { plaintext } = msg.sessionDecryptBytes(sentParams.encryptedMessage, secret);
            expect(plaintext.equals(payload)).to.equal(true);
        });

        it('encrypts a binary payload with AES method (round-trips via aesDecryptBytes)', async function () {
            const crypto = require('crypto');
            const key = crypto.randomBytes(32).toString('hex');
            const payload = Buffer.concat([Buffer.from([0x01, 0x00, 0xff]), crypto.randomBytes(30)]);
            let sentParams = null;
            const fakeSdk = {
                createAction: async (data) => { sentParams = data.params; return { psbt: 'p', actionString: 'XC|MSG' }; },
                wallet: {
                    signPsbt:    () => ({ txHex: 'txhex', txid: 'txaesbin' }),
                    broadcastTx: async () => ({})
                },
                _requireEncoder: () => ({}),
            };
            const result = await msg.send(
                { wif: 'wif', coin: 'BTC', destination: 'addr', message: payload, encoder: {}, method: 3, sharedKey: key },
                fakeSdk
            );
            expect(result.txid).to.equal('txaesbin');
            const { plaintext } = msg.aesDecryptBytes(sentParams.encryptedMessage, key);
            expect(plaintext.equals(payload)).to.equal(true);
        });

        it('throws SHARED_SECRET_REQUIRED for ECDH without sharedSecret', async function () {
            await msg.send({ wif: 'wif', coin: 'BTC', destination: 'addr', message: 'hi', encoder: {}, method: 2 }, {})
                .then(() => { throw new Error('should throw'); }, e => expect(e.code).to.equal('SHARED_SECRET_REQUIRED'));
        });

        it('throws SHARED_KEY_REQUIRED for AES without sharedKey', async function () {
            await msg.send({ wif: 'wif', coin: 'BTC', destination: 'addr', message: 'hi', encoder: {}, method: 3 }, {})
                .then(() => { throw new Error('should throw'); }, e => expect(e.code).to.equal('SHARED_KEY_REQUIRED'));
        });

        it('throws PUBKEY_NOT_FOUND when ECIES and explorer finds no pubkey', async function () {
            const fakeSdk = {
                _requireExplorer: () => ({ getPublicKey: async () => null })
            };
            await msg.send({ wif: 'wif', coin: 'BTC', destination: 'addr', message: 'hi', encoder: {}, method: 1 }, fakeSdk)
                .then(() => { throw new Error('should throw'); }, e => expect(e.code).to.equal('PUBKEY_NOT_FOUND'));
        });

        // Happy-path for send(): uses method=null (plaintext) so we can avoid
        // encoding and signing (stub createAction + wallet.signPsbt + broadcastTx).
        it('returns txid and actionString on a successful plaintext send', async function () {
            const fakeSdk = {
                createAction: async () => ({ psbt: 'psbtHex', actionString: 'XC|MSG' }),
                wallet: {
                    signPsbt:    () => ({ txHex: 'txhex', txid: 'txabc' }),
                    broadcastTx: async () => ({})
                },
                _requireEncoder: () => ({}),
            };
            const result = await msg.send(
                { wif: 'wif', coin: 'BTC', destination: 'addr', message: 'hello', encoder: {}, method: null },
                fakeSdk
            );
            expect(result.txid).to.equal('txabc');
            expect(result.actionString).to.equal('XC|MSG');
        });

        // Happy-path for ECDH (method=2) send
        it('returns txid on a successful ECDH send', async function () {
            const crypto = require('crypto');
            const secret = crypto.randomBytes(32).toString('hex');
            const fakeSdk = {
                createAction: async () => ({ psbt: 'psbtHex', actionString: 'XC|MSG' }),
                wallet: {
                    signPsbt:    () => ({ txHex: 'txhex', txid: 'txecdh' }),
                    broadcastTx: async () => ({})
                },
                _requireEncoder: () => ({}),
            };
            const result = await msg.send(
                { wif: 'wif', coin: 'BTC', destination: 'addr', message: 'hi', encoder: {}, method: 2, sharedSecret: secret },
                fakeSdk
            );
            expect(result.txid).to.equal('txecdh');
        });

        // Happy-path for AES (method=3) send
        it('returns txid on a successful AES send', async function () {
            const crypto = require('crypto');
            const key = crypto.randomBytes(32).toString('hex');
            const fakeSdk = {
                createAction: async () => ({ psbt: 'psbtHex', actionString: 'XC|MSG' }),
                wallet: {
                    signPsbt:    () => ({ txHex: 'txhex', txid: 'txaes' }),
                    broadcastTx: async () => ({})
                },
                _requireEncoder: () => ({}),
            };
            const result = await msg.send(
                { wif: 'wif', coin: 'BTC', destination: 'addr', message: 'secret', encoder: {}, method: 3, sharedKey: key },
                fakeSdk
            );
            expect(result.txid).to.equal('txaes');
        });

        // Happy-path for ECIES (method=1) send: requires a found pubkey.
        // Uses the REAL createAction (normalizeFields + format selector) rather than a
        // stub: send() no longer sets encryptionMethod on actionParams, so the selector
        // must resolve MESSAGE v2. (Pre-fix this threw NO_MATCHING_FORMAT, which the old
        // createAction stub hid: that false-green is the bug this regression guards.)
        it('encodes a real MESSAGE v2 action and returns txid on a successful ECIES send', async function () {
            const Actions = require('../../src/actions.js');
            const Utility = require('../../src/utility.js');
            const realActions = new Actions({ util: new Utility(), config: {} });
            const bob = keypair();
            const dest = new WalletUtils(NETWORK).deriveAddress(bob.publicKeyHex);
            let encodedActionString = null;
            const fakeSdk = {
                _requireExplorer: () => ({ getPublicKey: async () => ({ pubkey: bob.publicKeyHex }) }),
                createAction:     async (data) => {
                    const res = realActions.createAction(data);
                    encodedActionString = res.actionString;
                    return res;
                },
                wallet: {
                    signPsbt:    () => ({ txHex: 'txhex', txid: 'txecies' }),
                    broadcastTx: async () => ({})
                },
                _requireEncoder: () => ({}),
            };
            const result = await msg.send(
                { wif: 'wif', coin: 'BTC', destination: dest, message: 'hello', encoder: {}, method: 1 },
                fakeSdk
            );
            expect(result.txid).to.equal('txecies');
            // MESSAGE|2|BTC|<dest>|<ciphertext>: version 2, no ENCRYPTION_METHOD field
            const parts = encodedActionString.split('|');
            expect(parts[0]).to.equal('MESSAGE');
            expect(parts[1]).to.equal('2');
            expect(parts[2]).to.equal('BTC');
            expect(parts[3]).to.equal(dest);
        });

        // Binary ECIES (method=1) send
        it('returns txid for binary ECIES send (Buffer message)', async function () {
            const bob = keypair();
            const fakeSdk = {
                _requireExplorer: () => ({ getPublicKey: async () => ({ pubkey: bob.publicKeyHex }) }),
                createAction:     async () => ({ psbt: 'psbtHex', actionString: 'XC|MSG' }),
                wallet: {
                    signPsbt:    () => ({ txHex: 'txhex', txid: 'txbinary' }),
                    broadcastTx: async () => ({})
                },
                _requireEncoder: () => ({}),
            };
            const result = await msg.send(
                { wif: 'wif', coin: 'BTC', destination: 'addr', message: Buffer.from('key_bytes'), encoder: {}, method: 1 },
                fakeSdk
            );
            expect(result.txid).to.equal('txbinary');
        });
    });
});
