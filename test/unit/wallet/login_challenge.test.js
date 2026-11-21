// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const { expect } = require('chai');
const {
    LOGIN_MAX_AGE_MS,
    parseLoginChallenge,
    checkLoginChallenge,
} = require('../../../src/utils/wallet/login_challenge.js');

const NOW = 2_000_000_000_000;
const BASE_PARTS = Object.freeze({
    version: 2,
    appId: 'example-app',
    origin: 'https://example.test',
    address: 'bc1qexample',
    nonce: 'nonce-123',
    timestamp: NOW - 1_000,
    expiresAt: NOW + 60_000,
});
const EXPECTED = Object.freeze({
    appId: BASE_PARTS.appId,
    origin: BASE_PARTS.origin,
    address: BASE_PARTS.address,
    nonce: BASE_PARTS.nonce,
    now: NOW,
});

function challenge(overrides = {}) {
    const parts = Object.assign({}, BASE_PARTS, overrides);
    return [
        'XChain Sign-In v2',
        parts.appId,
        parts.origin,
        parts.address,
        parts.nonce,
        parts.timestamp,
        parts.expiresAt,
    ].join(' | ');
}

describe('parseLoginChallenge()', function () {
    it('parses the exact seven-field v2 wire format', function () {
        expect(parseLoginChallenge(challenge())).to.deep.equal({ ok: true, parts: BASE_PARTS });
    });

    it('refuses the v1 prefix and any other prefix', function () {
        expect(parseLoginChallenge(challenge().replace('v2', 'v1')).ok).to.equal(false);
        expect(parseLoginChallenge(challenge().replace('XChain Sign-In v2', 'other')).ok)
            .to.equal(false);
    });

    it('requires exactly seven fields split on the literal separator', function () {
        expect(parseLoginChallenge(challenge() + ' | extra').ok).to.equal(false);
        expect(parseLoginChallenge(challenge().replace(' | nonce-123', '')).ok).to.equal(false);
        expect(parseLoginChallenge(challenge().replaceAll(' | ', '|')).ok).to.equal(false);
    });

    it('requires timestamp fields to be decimal safe integers', function () {
        for (const value of ['1.5', '1e3', '-1', 'Infinity', '', '9007199254740992']) {
            expect(parseLoginChallenge(challenge({ timestamp: value })).ok, value).to.equal(false);
            expect(parseLoginChallenge(challenge({ expiresAt: value })).ok, value).to.equal(false);
        }
    });

    it('returns an error instead of throwing for non-string input', function () {
        for (const value of [null, undefined, 1, {}, Symbol('challenge')]) {
            expect(() => parseLoginChallenge(value)).not.to.throw();
            expect(parseLoginChallenge(value)).to.include({ ok: false });
        }
    });
});

describe('checkLoginChallenge() bindings and lifetime', function () {
    it('exports the 60 minute cap and accepts a bound, current challenge', function () {
        expect(LOGIN_MAX_AGE_MS).to.equal(60 * 60 * 1000);
        expect(checkLoginChallenge(BASE_PARTS, EXPECTED, {})).to.equal(null);
    });

    it('refuses every mismatched binding field', function () {
        for (const field of ['appId', 'origin', 'nonce', 'address']) {
            const expected = Object.assign({}, EXPECTED, { [field]: 'wrong' });
            expect(checkLoginChallenge(BASE_PARTS, expected, {})).to.match(new RegExp(field));
        }
    });

    it('refuses unsupported versions, future timestamps, and invalid expiry order', function () {
        expect(checkLoginChallenge(Object.assign({}, BASE_PARTS, { version: 1 }), EXPECTED, {}))
            .to.match(/version/);
        expect(checkLoginChallenge(Object.assign({}, BASE_PARTS, { timestamp: NOW + 1 }), EXPECTED, {}))
            .to.match(/future/);
        expect(checkLoginChallenge(Object.assign({}, BASE_PARTS, {
            timestamp: NOW - 1_000,
            expiresAt: NOW - 1_000,
        }), EXPECTED, {})).to.match(/after timestamp/);
    });

    it('refuses a challenge after its signed expiry', function () {
        const parts = Object.assign({}, BASE_PARTS, { expiresAt: NOW - 1 });
        expect(checkLoginChallenge(parts, EXPECTED, {})).to.match(/expired/);
    });
});

describe('checkLoginChallenge() age options', function () {
    it('applies a smaller positive maxAgeMs and accepts its boundary', function () {
        expect(checkLoginChallenge(BASE_PARTS, EXPECTED, { maxAgeMs: 999 })).to.match(/old/);
        expect(checkLoginChallenge(BASE_PARTS, EXPECTED, { maxAgeMs: 1_000 })).to.equal(null);
    });

    it('caps maxAgeMs at 60 minutes', function () {
        const age = LOGIN_MAX_AGE_MS + 1;
        const parts = Object.assign({}, BASE_PARTS, {
            timestamp: NOW - age,
            expiresAt: NOW + 1,
        });
        expect(checkLoginChallenge(parts, EXPECTED, { maxAgeMs: LOGIN_MAX_AGE_MS * 2 }))
            .to.match(/old/);
    });

    it('uses the cap for a missing, non-finite, or non-positive maxAgeMs', function () {
        const parts = Object.assign({}, BASE_PARTS, {
            timestamp: NOW - LOGIN_MAX_AGE_MS,
            expiresAt: NOW + 1,
        });
        for (const maxAgeMs of [undefined, NaN, Infinity, 0, -1]) {
            expect(checkLoginChallenge(parts, EXPECTED, { maxAgeMs }), String(maxAgeMs))
                .to.equal(null);
        }
    });
});

describe('checkLoginChallenge() malformed input handling', function () {
    it('never throws on malformed arguments or throwing property access', function () {
        const hostile = new Proxy({}, { get() { throw new Error('nope'); } });
        for (const args of [
            [null, EXPECTED, {}],
            [BASE_PARTS, null, {}],
            [hostile, EXPECTED, {}],
            [BASE_PARTS, hostile, {}],
            [BASE_PARTS, EXPECTED, hostile],
        ]) {
            expect(() => checkLoginChallenge(...args)).not.to.throw();
            expect(checkLoginChallenge(...args)).to.be.a('string');
        }
    });
});
