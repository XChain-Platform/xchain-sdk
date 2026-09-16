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

//  getMessages(): ECDH pubkey-lookup budget
//
//  Each ECDH-fallback cache miss is an explorer round-trip, so an inbox
//  full of undecryptable messages from unique senders must not fan out one
//  request per message.

// `count` rows, each from a distinct sender, carrying a blob that is
// neither valid ECIES nor valid ECDH for the reader: every one of them
// reaches the pubkey-resolution path.
function undecryptableInbox(count) {
    let rows = [];
    for (let i = 0; i < count; i++) {
        rows.push({
            source: `S${i}`, destination: 'B',
            encrypted_message: crypto.randomBytes(80).toString('hex'),
            tx_hash: `t${i}`, block_index: i
        });
    }
    return rows;
}

// Explorer that counts pubkey lookups and always resolves.
function countingExplorer(rows, pubkeyHex) {
    const calls = [];
    return {
        calls,
        getMessages: async () => rows,
        getPublicKey: async (addr) => { calls.push(addr); return { pubkey: pubkeyHex }; }
    };
}
describe('MessagingUtils @crypto @regression', function () {

    let msg;
    beforeEach(function () { msg = new MessagingUtils(NETWORK); });

    describe('getMessages(): ECDH pubkey-lookup cap', function () {

        it('caps pubkey lookups at the default 25 across a large undecryptable inbox', async function () {
            const alice = keypair(), bob = keypair();
            const explorer = countingExplorer(undecryptableInbox(60), alice.publicKeyHex);

            const out = await msg.getMessages('B', { wif: bob.wif, type: 'received' }, explorer);

            expect(out).to.have.lengthOf(60);
            expect(explorer.calls).to.have.lengthOf(25);
            // Nothing decrypts here, so every row stays flagged encrypted.
            expect(out.every(m => m.encrypted === true && m.text === null)).to.equal(true);
        });

        it('spends only one lookup for many messages from the same sender', async function () {
            const alice = keypair(), bob = keypair();
            const rows = undecryptableInbox(40).map(r => ({ ...r, source: 'A' }));
            const explorer = countingExplorer(rows, alice.publicKeyHex);

            await msg.getMessages('B', { wif: bob.wif, type: 'received' }, explorer);

            expect(explorer.calls).to.deep.equal(['A']);
        });

        it('caches an unresolvable sender so it never costs a second lookup', async function () {
            const bob = keypair();
            const rows = undecryptableInbox(10).map(r => ({ ...r, source: 'A' }));
            const explorer = countingExplorer(rows, null);
            explorer.getPublicKey = async (addr) => { explorer.calls.push(addr); return null; };

            await msg.getMessages('B', { wif: bob.wif, type: 'received' }, explorer);

            expect(explorer.calls).to.have.lengthOf(1);
        });
    });
});

describe('MessagingUtils @crypto @regression', function () {

    let msg;
    beforeEach(function () { msg = new MessagingUtils(NETWORK); });

    describe('getMessages(): ECDH pubkey-lookup cap', function () {

        it('honours opts.maxPubkeyLookups and still decrypts senders resolved inside the budget', async function () {
            const alice = keypair(), bob = keypair();
            const secret = msg.deriveSharedSecret(alice.wif, bob.publicKeyHex).sharedSecret;
            const { ciphertext } = msg.sessionEncrypt('ecdh hello', secret);
            const rows = [
                { source: 'A', destination: 'B', encrypted_message: ciphertext, tx_hash: 't', block_index: 1 },
                ...undecryptableInbox(20)
            ];
            const explorer = countingExplorer(rows, alice.publicKeyHex);

            const out = await msg.getMessages('B', { wif: bob.wif, type: 'received', maxPubkeyLookups: 3 }, explorer);

            expect(explorer.calls).to.have.lengthOf(3);
            expect(out[0].text).to.equal('ecdh hello');
            expect(out[0].method).to.equal(2);
            // Past the budget the rows are returned untouched, not dropped.
            expect(out).to.have.lengthOf(21);
            expect(out.slice(1).every(m => m.text === null && m.encrypted === true)).to.equal(true);
        });

        it('maxPubkeyLookups: 0 disables ECDH lookups entirely', async function () {
            const alice = keypair(), bob = keypair();
            const explorer = countingExplorer(undecryptableInbox(5), alice.publicKeyHex);

            await msg.getMessages('B', { wif: bob.wif, type: 'received', maxPubkeyLookups: 0 }, explorer);

            expect(explorer.calls).to.have.lengthOf(0);
        });

        it('falls back to the default cap on a junk maxPubkeyLookups instead of going unbounded', async function () {
            const alice = keypair(), bob = keypair();
            for (const bad of [-1, NaN, 'lots', {}]) {
                const explorer = countingExplorer(undecryptableInbox(40), alice.publicKeyHex);
                await msg.getMessages('B', { wif: bob.wif, type: 'received', maxPubkeyLookups: bad }, explorer);
                expect(explorer.calls, `budget ${String(bad)}`).to.have.lengthOf(25);
            }
        });

        it('maxPubkeyLookups: Infinity opts out of the cap', async function () {
            const alice = keypair(), bob = keypair();
            const explorer = countingExplorer(undecryptableInbox(40), alice.publicKeyHex);

            await msg.getMessages('B', { wif: bob.wif, type: 'received', maxPubkeyLookups: Infinity }, explorer);

            expect(explorer.calls).to.have.lengthOf(40);
        });
    });
});
