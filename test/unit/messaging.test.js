// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
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
    //  ECIES (method 1) — string payloads
    // -----------------------------------------------------------------------
    describe('ECIES — string', function () {

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

        it('carries exactly the documented 61-byte overhead (GCM is length-preserving)', function () {
            const bob = keypair();
            const { ciphertext } = msg.eciesEncrypt('A', bob.publicKeyHex); // 1-byte plaintext
            expect(Buffer.from(ciphertext, 'hex').length).to.equal(33 + 12 + 16 + 1);
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

        it('rejects empty plaintext, missing/short pubkey, short ciphertext, bad WIF', function () {
            const bob = keypair();
            expectCode(() => msg.eciesEncrypt('', bob.publicKeyHex), 'INVALID_MESSAGE');
            expectCode(() => msg.eciesEncrypt('m', null), 'INVALID_PUBKEY');
            expectCode(() => msg.eciesEncrypt('m', Buffer.alloc(20)), 'INVALID_PUBKEY');
            const ok = msg.eciesEncrypt('m', bob.publicKeyHex).ciphertext;
            expectCode(() => msg.eciesDecrypt('00', bob.wif), 'INVALID_CIPHERTEXT');
            expectCode(() => msg.eciesDecrypt(ok, 'not-a-wif'), 'INVALID_WIF');
        });
    });

    // -----------------------------------------------------------------------
    //  ECIES (method 1) — binary payloads (gated-content key handoff)
    // -----------------------------------------------------------------------
    describe('ECIES — bytes', function () {

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
    //  ECDH (method 2) — session communication
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
    //  AES (method 3) — pre-shared key
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
    });

    // -----------------------------------------------------------------------
    //  High-level getMessages() — decryption integration
    // -----------------------------------------------------------------------
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

        it('decrypts an ECIES message when a wif is supplied (text + bytes)', async function () {
            const bob = keypair();
            const { ciphertext } = msg.eciesEncrypt('hi bob', bob.publicKeyHex);
            const explorer = explorerReturning([
                { source: 'A', destination: 'B', encryption_method: 1, encrypted_message: ciphertext, tx_hash: 't', block_index: 7 }
            ]);
            const out = await msg.getMessages('B', { wif: bob.wif, type: 'received' }, explorer);
            expect(out[0].text).to.equal('hi bob');
            expect(out[0].encrypted).to.equal(true);
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
    });
});
