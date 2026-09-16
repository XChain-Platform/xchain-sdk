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

// getPublicKey()
describe('MessagingUtils @crypto @regression', function () {

    let msg;
    beforeEach(function () { msg = new MessagingUtils(NETWORK); });

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
});
