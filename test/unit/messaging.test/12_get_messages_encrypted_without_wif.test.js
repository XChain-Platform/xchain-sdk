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

// getMessages(): encrypted_message without wif (sets encrypted=true)
describe('MessagingUtils @crypto @regression', function () {

    let msg;
    beforeEach(function () { msg = new MessagingUtils(NETWORK); });

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
    });
});

describe('MessagingUtils @crypto @regression', function () {

    let msg;
    beforeEach(function () { msg = new MessagingUtils(NETWORK); });

    describe('getMessages(): encrypted without wif', function () {

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
});
