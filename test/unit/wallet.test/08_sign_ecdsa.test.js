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
const WalletUtils = require('../../../src/utils/wallet.js');

describe('WalletUtils', function() {

    describe('signEcdsa()', function() {
        it('should return a DER-encoded signature for valid inputs', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const kp = wallet.generateKeyPair();
            // secretKey is kp.privateKey (Buffer → Uint8Array view)
            const secretKey = new Uint8Array(kp.privateKey);
            const msgHash = new Uint8Array(32).fill(0xab);
            const sig = wallet.signEcdsa(msgHash, secretKey);
            expect(sig).to.be.instanceof(Uint8Array);
            // DER signature starts with 0x30
            expect(sig[0]).to.equal(0x30);
            // Length byte at sig[1] should cover the rest
            expect(sig.length).to.equal(sig[1] + 2);
        });

        it('should throw INVALID_INPUT for wrong msgHash type (string)', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            // Pass a plain string (not a Uint8Array); the instanceof check fires
            expect(() => wallet.signEcdsa('notauint8array', new Uint8Array(32))).to.throw(/msgHash must be a 32-byte Uint8Array/);
        });

        it('should throw INVALID_INPUT for wrong msgHash length', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const secretKey = new Uint8Array(32).fill(1);
            expect(() => wallet.signEcdsa(new Uint8Array(16), secretKey)).to.throw(/msgHash must be a 32-byte Uint8Array/);
        });

        it('should throw INVALID_INPUT for wrong secretKey type (string)', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            // Valid msgHash (Uint8Array, 32 bytes), but secretKey is a plain string
            expect(() => wallet.signEcdsa(new Uint8Array(32), 'notauint8array')).to.throw(/secretKey must be a 32-byte Uint8Array/);
        });

        it('should throw INVALID_INPUT for wrong secretKey length', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            expect(() => wallet.signEcdsa(new Uint8Array(32), new Uint8Array(16))).to.throw(/secretKey must be a 32-byte Uint8Array/);
        });
    });
});

describe('WalletUtils', function() {

    describe('signEcdsa()', function() {
        it('should throw INVALID_INPUT for invalid secp256k1 scalar (zero key)', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const badKey = new Uint8Array(32); // all zeros (invalid scalar)
            expect(() => wallet.signEcdsa(new Uint8Array(32), badKey)).to.throw(/not a valid secp256k1 scalar/);
        });

        it('should produce consistent DER structure across varying r/s magnitudes', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            // Use a known-valid key
            const kp = wallet.generateKeyPair();
            const secretKey = new Uint8Array(kp.privateKey);
            // Sign 10 different messages; all should parse as valid DER
            for (let i = 0; i < 10; i++) {
                const msgHash = new Uint8Array(32).fill(i + 1);
                const sig = wallet.signEcdsa(msgHash, secretKey);
                expect(sig[0]).to.equal(0x30); // SEQUENCE
                expect(sig[2]).to.equal(0x02); // INTEGER for r
                const rLen = sig[3];
                expect(sig[4 + rLen]).to.equal(0x02); // INTEGER for s
            }
        });
    });
});
