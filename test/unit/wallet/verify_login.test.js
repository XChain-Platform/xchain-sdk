// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const { expect } = require('chai');
const AuthUtils = require('../../../src/utils/auth.js');
const {
    LOGIN_MAX_AGE_MS,
    parseLoginChallenge,
} = require('../../../src/utils/wallet/login_challenge.js');

const NETWORK = 'bitcoin-mainnet';
const APP_ID = 'login-test';
const ORIGIN = 'https://login.example';
const NONCE = 'server-issued-nonce';
const NOW = 2_000_000_000_000;
const WIF = 'KyrSGCFPhqZMjCe5fNTYddiLMp4tMj4gLKuJ26TsB2rvr1VJGPbt';

function challenge(address, timestamp = NOW - 1_000, expiresAt = NOW + 60_000) {
    return ['XChain Sign-In v2', APP_ID, ORIGIN, address, NONCE, timestamp, expiresAt].join(' / ');
}

function signedEntry(auth, format, timestamp, expiresAt) {
    const address = auth.signMessage('address probe', WIF, {
        format,
        auxRand: Buffer.alloc(32),
    }).address;
    const text = challenge(address, timestamp, expiresAt);
    const signed = auth.signMessage(text, WIF, {
        format,
        auxRand: Buffer.alloc(32),
    });
    return {
        address,
        chainId: NETWORK,
        addressType: format === 'legacy' ? 'p2pkh' : 'p2tr',
        challenge: text,
        signature: signed.signature,
        signatureFormat: format,
    };
}

function loginResult(entries) {
    const first = entries[0];
    return Object.assign({
        ok: true,
        addresses: entries,
        challengeParts: parseLoginChallenge(first.challenge).parts,
    }, first);
}

function verifyAt(auth, result, maxAgeMs) {
    const originalNow = Date.now;
    Date.now = () => NOW;
    try {
        return auth.verifyLogin(result, { appId: APP_ID, origin: ORIGIN, nonce: NONCE, maxAgeMs });
    } finally {
        Date.now = originalNow;
    }
}

describe('AuthUtils.verifyLogin()', function () {
    const auth = new AuthUtils(NETWORK);

    it('verifies every returned address in its declared signature format', function () {
        const legacy = signedEntry(auth, 'legacy');
        const taproot = signedEntry(auth, 'bip322-simple');
        const result = verifyAt(auth, loginResult([legacy, taproot]));

        expect(result).to.deep.equal({
            valid: true,
            address: legacy.address,
            chainId: NETWORK,
            addresses: [
                { address: legacy.address, chainId: NETWORK },
                { address: taproot.address, chainId: NETWORK },
            ],
            error: null,
        });
    });

    it('refuses the whole login when a later address signature is invalid', function () {
        const legacy = signedEntry(auth, 'legacy');
        const taproot = signedEntry(auth, 'bip322-simple');
        taproot.signature = taproot.signature.slice(0, -1) + 'A';

        const result = verifyAt(auth, loginResult([legacy, taproot]));
        expect(result.valid).to.equal(false);
        expect(result.addresses).to.deep.equal([]);
        expect(result.error).to.match(/signature/i);
    });

    it('binds app, origin, nonce, address, format, chain, and top-level identity', function () {
        const entry = signedEntry(auth, 'legacy');
        const base = loginResult([entry]);
        const cases = [
            [Object.assign({}, base, { address: 'wrong' }), {}],
            [base, { appId: 'wrong' }],
            [base, { origin: 'https://wrong.example' }],
            [base, { nonce: 'wrong' }],
            [loginResult([Object.assign({}, entry, { chainId: 'unknown-chain' })]), {}],
            [loginResult([Object.assign({}, entry, { signatureFormat: 'unknown' })]), {}],
        ];

        for (const [result, overrides] of cases) {
            const originalNow = Date.now;
            Date.now = () => NOW;
            try {
                expect(auth.verifyLogin(result, Object.assign({
                    appId: APP_ID,
                    origin: ORIGIN,
                    nonce: NONCE,
                }, overrides)).valid).to.equal(false);
            } finally {
                Date.now = originalNow;
            }
        }
    });

    it('applies a smaller maxAgeMs and caps a larger one at 60 minutes', function () {
        const boundary = signedEntry(auth, 'legacy', NOW - LOGIN_MAX_AGE_MS, NOW + 1);
        expect(verifyAt(auth, loginResult([boundary]), LOGIN_MAX_AGE_MS * 2).valid).to.equal(true);

        const overCap = signedEntry(auth, 'legacy', NOW - LOGIN_MAX_AGE_MS - 1, NOW + 1);
        expect(verifyAt(auth, loginResult([overCap]), LOGIN_MAX_AGE_MS * 2).error)
            .to.match(/too old/);

        const short = signedEntry(auth, 'legacy', NOW - 1_001, NOW + 1);
        expect(verifyAt(auth, loginResult([short]), 1_000).error).to.match(/too old/);
    });

    it('refuses malformed and hostile values without throwing', function () {
        const hostile = new Proxy({}, { get() { throw new Error('nope'); } });
        for (const [result, expected] of [
            [null, null],
            [{}, {}],
            [hostile, {}],
            [{ ok: true, addresses: [hostile] }, { appId: APP_ID, origin: ORIGIN, nonce: NONCE }],
            [loginResult([signedEntry(auth, 'legacy')]), hostile],
        ]) {
            expect(() => auth.verifyLogin(result, expected)).not.to.throw();
            expect(auth.verifyLogin(result, expected).valid).to.equal(false);
        }
    });
});
