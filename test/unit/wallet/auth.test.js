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
const AuthUtils = require('../../../src/utils/auth.js');
const WalletUtils = require('../../../src/utils/wallet.js');

const NETWORKS = ['bitcoin-regtest', 'litecoin-regtest', 'dogecoin-regtest'];

describe('AuthUtils', function() {

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

});

describe('AuthUtils', function() {

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

});

// A witness program is anyone-can-spend on DOGE, so both segwit modes must refuse there
describe('AuthUtils signMessage() segwit options on a non-segwit network', function() {
    for (const opts of [{ segwitRedeemScript: true }, { segwitNative: true }]) {
        it(`refuses ${Object.keys(opts)[0]} on dogecoin, instance and per-call network`, function() {
            const dogeWif = new WalletUtils('dogecoin-regtest').generateKeyPair().wif;
            const code = (fn) => { try { fn(); return 'NO THROW'; } catch (e) { return e.code; } };
            expect(code(() => new AuthUtils('dogecoin-regtest').signMessage('m', dogeWif, opts)))
                .to.equal('SEGWIT_NOT_SUPPORTED');
            expect(code(() => new AuthUtils('bitcoin-regtest').signMessage('m', dogeWif,
                Object.assign({ network: 'dogecoin-regtest' }, opts)))).to.equal('SEGWIT_NOT_SUPPORTED');
        });
    }
});

describe('AuthUtils', function() {

    describe('verifyOwnership() - failure cases', function() {
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

});

describe('AuthUtils', function() {

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

});

describe('AuthUtils', function() {

    describe('signMessage() - error cases', function() {
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

});

describe('AuthUtils', function() {

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

});

describe('AuthUtils', function() {

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

describe('AuthUtils custom challenge templating', function() {
    const auth = new AuthUtils('bitcoin-regtest');

    it('should fill custom challenge placeholders', function() {
        const template = 'Address: {address}\nNonce: {nonce}\nTime: {timestamp}\nExpires: {expiresAt}';
        const result = auth.generateChallenge('bc1qtest', { message: template });
        expect(result.challenge).to.include('Address: bc1qtest');
        expect(result.challenge).to.include(`Nonce: ${result.nonce}`);
        expect(result.challenge).to.include(`Time: ${result.timestamp}`);
        expect(result.challenge).to.include(`Expires: ${result.expiresAt}`);
        expect(result.challenge).to.not.include('{nonce}');
        expect(result.bound).to.equal(true);
    });

    it('should keep a custom message that embeds the supplied nonce unchanged', function() {
        const customMsg = 'Please sign this to verify your wallet. Nonce: deadbeef';
        const result = auth.generateChallenge('bc1qtest', { message: customMsg, nonce: 'deadbeef' });
        expect(result.challenge).to.equal(customMsg);
        expect(result.nonce).to.equal('deadbeef');
        expect(result.bound).to.equal(false);
    });

    it('should bind a caller-supplied nonce only through the nonce placeholder', function() {
        const result = auth.generateChallenge('bc1qtest', {
            message: 'Please sign. Nonce: {nonce}', nonce: '24', requireNonce: true
        });
        expect(result.challenge).to.equal('Please sign. Nonce: 24');
        expect(result.bound).to.equal(true);
    });

    it('should reject a non-string custom challenge', function() {
        expect(() => auth.generateChallenge('bc1qtest', { message: { nonce: true } }))
            .to.throw().with.property('code', 'INVALID_MESSAGE');
    });

    it('should sign and verify a templated custom challenge', function() {
        const wallet = new WalletUtils('bitcoin-regtest');
        const kp = wallet.generateKeyPair();
        const address = wallet.deriveAddress(kp.publicKey);
        const result = auth.generateChallenge(address, { message: 'Verify {address}\nNonce: {nonce}' });
        const signed = auth.signMessage(result.challenge, kp.wif);
        expect(auth.verifyOwnership(address, result.challenge, signed.signature).valid).to.be.true;
    });
});

describe('AuthUtils unbound custom challenges', function() {
    const auth = new AuthUtils('bitcoin-regtest');

    it('should flag a custom challenge that omits its nonce and warn once', function() {
        const fresh = new AuthUtils('bitcoin-regtest');
        const original = process.emitWarning;
        const warnings = [];
        process.emitWarning = (msg, type) => warnings.push({ msg, type });
        try {
            const first = fresh.generateChallenge('bc1qtest', { message: 'Static message' });
            const second = fresh.generateChallenge('bc1qtest', { message: 'Static message' });
            expect(first.challenge).to.equal('Static message');
            expect(first.bound).to.equal(false);
            expect(second.bound).to.equal(false);
        } finally {
            process.emitWarning = original;
        }
        expect(warnings).to.have.length(1);
        expect(warnings[0].type).to.equal('UnboundChallengeWarning');
    });

    it('should refuse a custom challenge without its nonce under requireNonce', function() {
        expect(() => auth.generateChallenge('bc1qtest', { message: 'Static message', requireNonce: true }))
            .to.throw().with.property('code', 'CHALLENGE_UNBOUND');
        const ok = auth.generateChallenge('bc1qtest', { message: 'Nonce: {nonce}', requireNonce: true });
        expect(ok.bound).to.equal(true);
    });

    it('should refuse a counter nonce that is only a substring of static text', function() {
        expect(() => auth.generateChallenge('bc1qtest', {
            message: 'Sign in to Web3 Shop 24/7', nonce: '24', requireNonce: true
        })).to.throw().with.property('code', 'CHALLENGE_UNBOUND');
    });
});

describe('AuthUtils custom challenge nonce provenance', function() {
    const auth = new AuthUtils('bitcoin-regtest');

    it('should not bind a supplied nonce through filled expiry digits', function() {
        const originalNow = Date.now;
        Date.now = () => Date.UTC(2026, 0, 2, 3, 4, 5);
        try {
            const result = auth.generateChallenge('bc1qtest', {
                message: 'Expires: {expiresAt}', nonce: '2026'
            });
            expect(result.challenge).to.include('2026');
            expect(result.bound).to.equal(false);
        } finally {
            Date.now = originalNow;
        }
    });

    it('should require delimiters around an SDK-generated nonce found in custom text', function() {
        const generatedNonce = 'ab'.repeat(32);
        const originalRandomBytes = crypto.randomBytes;
        crypto.randomBytes = () => Buffer.from(generatedNonce, 'hex');
        try {
            const result = auth.generateChallenge('bc1qtest', {
                message: `Sign in. Nonce: ${generatedNonce}.`, requireNonce: true
            });
            expect(result.bound).to.equal(true);
            expect(() => auth.generateChallenge('bc1qtest', {
                message: `prefix${generatedNonce}suffix`, requireNonce: true
            })).to.throw().with.property('code', 'CHALLENGE_UNBOUND');
        } finally {
            crypto.randomBytes = originalRandomBytes;
        }
    });

    it('should report the default challenge as bound', function() {
        expect(auth.generateChallenge('bc1qtest').bound).to.equal(true);
    });
});
