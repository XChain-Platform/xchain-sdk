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
const AuthUtils = require('../../src/auth.js');
const WalletUtils = require('../../src/wallet.js');

describe('AuthUtils', function() {

    const NETWORKS = ['bitcoin-regtest', 'litecoin-regtest', 'dogecoin-regtest'];

    describe('generateChallenge()', function() {
        const auth = new AuthUtils('bitcoin-regtest');

        it('should generate a default challenge with address', function() {
            const result = auth.generateChallenge('bc1qtest123');
            expect(result).to.have.property('challenge');
            expect(result).to.have.property('nonce');
            expect(result).to.have.property('timestamp');
            expect(result).to.have.property('expiresAt');
            expect(result.challenge).to.include('XChain wallet verification');
            expect(result.challenge).to.include('bc1qtest123');
            expect(result.nonce).to.have.lengthOf(64); // 32 bytes hex
        });

        it('should include custom appId in default message', function() {
            const result = auth.generateChallenge('bc1qtest', { appId: 'MyApp' });
            expect(result.challenge).to.include('App: MyApp');
        });

        it('should use custom message as-is when provided', function() {
            const customMsg = 'Please sign this to verify your wallet.';
            const result = auth.generateChallenge('bc1qtest', { message: customMsg });
            expect(result.challenge).to.equal(customMsg);
            // Should still return nonce and timestamp metadata
            expect(result.nonce).to.be.a('string');
            expect(result.timestamp).to.be.a('string');
        });

        it('should accept custom nonce', function() {
            const result = auth.generateChallenge('bc1qtest', { nonce: 'deadbeef' });
            expect(result.nonce).to.equal('deadbeef');
            expect(result.challenge).to.include('deadbeef');
        });

        it('should throw on missing address', function() {
            expect(() => auth.generateChallenge()).to.throw(/Address is required/);
            expect(() => auth.generateChallenge('')).to.throw(/Address is required/);
        });

        it('should set expiresAt 5 minutes in the future by default', function() {
            const before = Date.now();
            const result = auth.generateChallenge('bc1qtest');
            const expiresAt = new Date(result.expiresAt).getTime();
            // Should be ~5 minutes from now (with small tolerance)
            expect(expiresAt - before).to.be.within(299000, 301000);
        });

        it('should respect custom expiresInMs', function() {
            const before = Date.now();
            const result = auth.generateChallenge('bc1qtest', { expiresInMs: 60000 });
            const expiresAt = new Date(result.expiresAt).getTime();
            expect(expiresAt - before).to.be.within(59000, 61000);
        });
    });

    describe('signMessage() + verifyOwnership() roundtrip', function() {

        for (const network of NETWORKS) {
            it(`should sign and verify on ${network}`, function() {
                const wallet = new WalletUtils(network);
                const auth = new AuthUtils(network);

                const kp = wallet.generateKeyPair();
                const address = wallet.deriveAddress(kp.publicKey);
                const message = `Test message for ${network}`;

                const signed = auth.signMessage(message, kp.wif);
                expect(signed).to.have.property('signature');
                expect(signed).to.have.property('address');
                expect(signed.address).to.equal(address);

                const verified = auth.verifyOwnership(address, message, signed.signature);
                expect(verified.valid).to.be.true;
                expect(verified.address).to.equal(address);
                expect(verified.error).to.be.null;
            });
        }

        it('should sign and verify with segwit native (bitcoin)', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const auth = new AuthUtils('bitcoin-regtest');

            const kp = wallet.generateKeyPair();
            const address = wallet.deriveAddress(kp.publicKey, { type: 'p2wpkh' });
            const message = 'Segwit native test';

            const signed = auth.signMessage(message, kp.wif, { segwitNative: true });
            expect(signed.address).to.equal(address);

            const verified = auth.verifyOwnership(address, message, signed.signature);
            expect(verified.valid).to.be.true;
        });

        it('should sign and verify with segwit P2SH-P2WPKH (bitcoin)', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const auth = new AuthUtils('bitcoin-regtest');

            const kp = wallet.generateKeyPair();
            const address = wallet.deriveAddress(kp.publicKey, { type: 'p2sh-p2wpkh' });
            const message = 'P2SH-P2WPKH test';

            const signed = auth.signMessage(message, kp.wif, { segwitRedeemScript: true });
            expect(signed.address).to.equal(address);

            const verified = auth.verifyOwnership(address, message, signed.signature);
            expect(verified.valid).to.be.true;
        });
    });

    describe('verifyOwnership() — failure cases', function() {
        const wallet = new WalletUtils('bitcoin-regtest');
        const auth = new AuthUtils('bitcoin-regtest');

        it('should return valid:false for wrong address', function() {
            const kp1 = wallet.generateKeyPair();
            const kp2 = wallet.generateKeyPair();
            const addr1 = wallet.deriveAddress(kp1.publicKey);
            const addr2 = wallet.deriveAddress(kp2.publicKey);
            const message = 'Wrong address test';

            const signed = auth.signMessage(message, kp1.wif);
            const result = auth.verifyOwnership(addr2, message, signed.signature);
            expect(result.valid).to.be.false;
        });

        it('should return valid:false for wrong message', function() {
            const kp = wallet.generateKeyPair();
            const address = wallet.deriveAddress(kp.publicKey);

            const signed = auth.signMessage('original message', kp.wif);
            const result = auth.verifyOwnership(address, 'tampered message', signed.signature);
            expect(result.valid).to.be.false;
        });

        it('should return valid:false for garbage signature', function() {
            const kp = wallet.generateKeyPair();
            const address = wallet.deriveAddress(kp.publicKey);
            const result = auth.verifyOwnership(address, 'test', 'not-a-real-signature');
            expect(result.valid).to.be.false;
            expect(result.error).to.be.a('string');
        });

        it('should return valid:false for missing params (not throw)', function() {
            expect(auth.verifyOwnership('', 'msg', 'sig').valid).to.be.false;
            expect(auth.verifyOwnership('addr', '', 'sig').valid).to.be.false;
            expect(auth.verifyOwnership('addr', 'msg', '').valid).to.be.false;
        });
    });

    describe('verifyMessage()', function() {
        it('should return { valid, error } without address field', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const auth = new AuthUtils('bitcoin-regtest');
            const kp = wallet.generateKeyPair();
            const address = wallet.deriveAddress(kp.publicKey);
            const message = 'verifyMessage test';

            const signed = auth.signMessage(message, kp.wif);
            const result = auth.verifyMessage(address, message, signed.signature);
            expect(result).to.have.property('valid', true);
            expect(result).to.have.property('error', null);
            expect(result).to.not.have.property('address');
        });
    });

    describe('signMessage() — error cases', function() {
        const auth = new AuthUtils('bitcoin-regtest');

        it('should throw on missing message', function() {
            expect(() => auth.signMessage('', 'wif')).to.throw(/Message is required/);
        });

        it('should throw on missing WIF', function() {
            expect(() => auth.signMessage('msg', '')).to.throw(/WIF private key is required/);
        });

        it('should throw on invalid WIF', function() {
            expect(() => auth.signMessage('msg', 'not-a-wif')).to.throw(/Failed to import WIF/);
        });
    });

    describe('network handling', function() {
        it('should throw when no network configured and no override', function() {
            const auth = new AuthUtils();
            expect(() => auth.signMessage('msg', 'wif')).to.throw(/Network not configured/);
        });

        it('should work with network override on verify', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const auth = new AuthUtils(); // no default network

            const kp = wallet.generateKeyPair();
            const address = wallet.deriveAddress(kp.publicKey);
            const message = 'network override test';

            const authWithNet = new AuthUtils('bitcoin-regtest');
            const signed = authWithNet.signMessage(message, kp.wif);

            // Verify with no default network but explicit override
            const result = auth.verifyOwnership(address, message, signed.signature, 'bitcoin-regtest');
            expect(result.valid).to.be.true;
        });
    });

    describe('custom message workflow', function() {
        it('should work end-to-end with a custom site-generated message', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const auth = new AuthUtils('bitcoin-regtest');

            const kp = wallet.generateKeyPair();
            const address = wallet.deriveAddress(kp.publicKey);

            // Site generates its own message (no SDK on server for generation)
            const siteMessage = `Sign this to prove you own ${address} - nonce: abc123`;

            // SDK used on client to sign
            const signed = auth.signMessage(siteMessage, kp.wif);

            // SDK used on server to verify (or site could use bitcoinjs-message directly)
            const verified = auth.verifyOwnership(address, siteMessage, signed.signature);
            expect(verified.valid).to.be.true;
        });
    });
});
