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

// send(): validation guards (does not need real network calls)
describe('MessagingUtils @crypto @regression', function () {

    let msg;
    beforeEach(function () { msg = new MessagingUtils(NETWORK); });

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
    });
});

describe('MessagingUtils @crypto @regression', function () {

    let msg;
    beforeEach(function () { msg = new MessagingUtils(NETWORK); });

    describe('send(): validation guards', function () {

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
    });
});

describe('MessagingUtils @crypto @regression', function () {

    let msg;
    beforeEach(function () { msg = new MessagingUtils(NETWORK); });

    describe('send(): validation guards', function () {

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
    });
});

describe('MessagingUtils @crypto @regression', function () {

    let msg;
    beforeEach(function () { msg = new MessagingUtils(NETWORK); });

    describe('send(): validation guards', function () {

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
    });
});

describe('MessagingUtils @crypto @regression', function () {

    let msg;
    beforeEach(function () { msg = new MessagingUtils(NETWORK); });

    describe('send(): validation guards', function () {

        // Happy-path for ECIES (method=1) send: requires a found pubkey.
        // Uses the REAL createAction (normalizeFields + format selector) rather than a
        // stub: send() no longer sets encryptionMethod on actionParams, so the selector
        // must resolve MESSAGE v2. (Pre-fix this threw NO_MATCHING_FORMAT, which the old
        // createAction stub hid: that false-green is the bug this regression guards.)
        it('encodes a real MESSAGE v2 action and returns txid on a successful ECIES send', async function () {
            const Actions = require('../../../../src/actions/index.js');
            const Utility = require('../../../../src/utils/utility.js');
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
    });
});

describe('MessagingUtils @crypto @regression', function () {

    let msg;
    beforeEach(function () { msg = new MessagingUtils(NETWORK); });

    describe('send(): validation guards', function () {

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
