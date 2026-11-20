// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('@bitcoinerlab/secp256k1');
const signedMessage = require('../../../src/utils/signed_message.js');
const fixture = require('../../fixtures/signed-message-vectors.json');
const { NETWORKS } = require('../../../src/protocol/networks.js');

function addGoldenVectorTests() {
    for (const vector of fixture.vectors) {
        it(`matches the golden signature for ${vector.id}`, function() {
            const options = vector.segwitType ? { segwitType: vector.segwitType } : undefined;
            const actual = signedMessage.sign(
                vector.message,
                Buffer.from(vector.privateKeyHex, 'hex'),
                vector.compressed,
                Buffer.from(vector.messagePrefixHex, 'hex'),
                options
            );
            assert.strictEqual(actual.toString('base64'), vector.signature);
            assert.strictEqual(signedMessage.verify(
                vector.message, vector.address, actual,
                Buffer.from(vector.messagePrefixHex, 'hex')
            ), true);
        });
    }
}

function addVerificationTests() {
    it('rejects tampered messages, addresses, and signature bytes', function() {
        const vector = fixture.vectors.find(item => item.id === 'bitcoin-mainnet-compressed');
        const signature = Buffer.from(vector.signature, 'base64');
        const otherKey = Buffer.from('03'.padStart(64, '0'), 'hex');
        const otherPubkey = Buffer.from(ecc.pointFromScalar(otherKey, true));
        const wrongAddress = bitcoin.payments.p2pkh({
            pubkey: otherPubkey,
            network: NETWORKS[vector.network]
        }).address;
        const prefix = Buffer.from(vector.messagePrefixHex, 'hex');
        const flipped = Buffer.from(signature);
        flipped[64] ^= 1;

        assert.strictEqual(signedMessage.verify(
            `${vector.message}!`, vector.address, signature, prefix
        ), false);
        assert.strictEqual(signedMessage.verify(
            vector.message, wrongAddress, signature, prefix
        ), false);
        assert.strictEqual(signedMessage.verify(
            vector.message, vector.address, flipped, prefix
        ), false);
    });

    it('supports Electrum-style segwit address checks for a legacy header', function() {
        const vector = fixture.vectors.find(item => item.id === 'bitcoin-mainnet-compressed');
        const privateKey = Buffer.from(vector.privateKeyHex, 'hex');
        const pubkey = Buffer.from(ecc.pointFromScalar(privateKey, true));
        const address = bitcoin.payments.p2wpkh({
            pubkey,
            network: NETWORKS[vector.network]
        }).address;
        assert.strictEqual(signedMessage.verify(
            vector.message, address, vector.signature,
            Buffer.from(vector.messagePrefixHex, 'hex'), true
        ), true);
    });

    it('refuses checkSegwitAlways with an uncompressed header', function() {
        const vector = fixture.vectors.find(item => item.id === 'bitcoin-mainnet-uncompressed');
        assert.throws(() => signedMessage.verify(
            vector.message, vector.address, vector.signature,
            Buffer.from(vector.messagePrefixHex, 'hex'), true
        ), /compressed pubkey signature flagbyte/);
    });
}

describe('signed message compatibility', function() {
    addGoldenVectorTests();
    addVerificationTests();
});
