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

describe('MessagingUtils @crypto @regression', function () {

    let msg;
    beforeEach(function () { msg = new MessagingUtils(NETWORK); });

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
});
