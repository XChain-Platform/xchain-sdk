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


function explorerReturning(rows, captured) {
    return { getMessages: async (address, queryType, opts) => {
        if (captured) { captured.address = address; captured.queryType = queryType; captured.opts = opts; }
        return rows;
    } };
}
describe('MessagingUtils @crypto @regression', function () {

    let msg;
    beforeEach(function () { msg = new MessagingUtils(NETWORK); });

    describe('getMessages()', function () {

        it('passes plaintext messages through untouched', async function () {
            const explorer = explorerReturning([
                { source: 'A', destination: 'B', plaintext_message: 'open msg', tx_hash: 't', block_index: 1 }
            ]);
            const out = await msg.getMessages('B', { type: 'received' }, explorer);
            expect(out).to.have.length(1);
            expect(out[0].text).to.equal('open msg');
            expect(out[0].encrypted).to.equal(false);
        });

        // the doubles above return a BARE ARRAY, but a real explorer
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
    });
});

describe('MessagingUtils @crypto @regression', function () {

    let msg;
    beforeEach(function () { msg = new MessagingUtils(NETWORK); });

    describe('getMessages()', function () {

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
    });
});

describe('MessagingUtils @crypto @regression', function () {

    let msg;
    beforeEach(function () { msg = new MessagingUtils(NETWORK); });

    describe('getMessages()', function () {

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
    });
});

describe('MessagingUtils @crypto @regression', function () {

    let msg;
    beforeEach(function () { msg = new MessagingUtils(NETWORK); });

    describe('getMessages()', function () {

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
});
