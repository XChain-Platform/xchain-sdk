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

// ECIES binary: error paths
describe('MessagingUtils @crypto @regression', function () {

    let msg;
    beforeEach(function () { msg = new MessagingUtils(NETWORK); });

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
});
