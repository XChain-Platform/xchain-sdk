/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Platform SDK - Login challenge validation
 *
 ********************************************************************/

'use strict';

const LOGIN_MAX_AGE_MS = 60 * 60 * 1000;
const LOGIN_CHALLENGE_PREFIX = 'XChain Sign-In v2';
const LOGIN_CHALLENGE_SEPARATOR = ' / ';
const DECIMAL_INTEGER = /^[0-9]+$/;

function parseLoginChallenge(text) {
    try {
        if (typeof text !== 'string') {
            return { ok: false, error: 'Login challenge must be a string' };
        }
        const fields = text.split(LOGIN_CHALLENGE_SEPARATOR);
        if (fields.length !== 7) {
            return { ok: false, error: 'Login challenge must contain exactly seven fields' };
        }
        const [prefix, appId, origin, address, nonce, timestampText, expiresAtText] = fields;
        if (prefix !== LOGIN_CHALLENGE_PREFIX) {
            return { ok: false, error: 'Unsupported login challenge prefix' };
        }
        if (!DECIMAL_INTEGER.test(timestampText) || !DECIMAL_INTEGER.test(expiresAtText)) {
            return { ok: false, error: 'Login challenge timestamps must be decimal integers' };
        }
        const timestamp = Number(timestampText);
        const expiresAt = Number(expiresAtText);
        if (!Number.isSafeInteger(timestamp) || !Number.isSafeInteger(expiresAt)) {
            return { ok: false, error: 'Login challenge timestamps must be safe decimal integers' };
        }
        return {
            ok: true,
            parts: {
                version: 2,
                appId,
                origin,
                address,
                nonce,
                timestamp,
                expiresAt,
            },
        };
    } catch (error) {
        return { ok: false, error: 'Invalid login challenge' };
    }
}

function checkLoginChallenge(parts, expected, options) {
    try {
        if (!parts || typeof parts !== 'object') return 'Invalid login challenge parts';
        if (!expected || typeof expected !== 'object') return 'Invalid expected login challenge fields';
        if (parts.version !== 2) return 'Unsupported login challenge version';

        for (const field of ['appId', 'origin', 'nonce', 'address']) {
            if (parts[field] !== expected[field]) return 'Login challenge ' + field + ' mismatch';
        }

        const timestamp = parts.timestamp;
        const expiresAt = parts.expiresAt;
        const now = expected.now === undefined ? Date.now() : expected.now;
        if (!Number.isFinite(now)) return 'Login challenge now must be finite';
        if (!Number.isSafeInteger(timestamp)) return 'Login challenge timestamp is invalid';
        if (!Number.isSafeInteger(expiresAt)) return 'Login challenge expiresAt is invalid';
        if (timestamp > now) return 'Login challenge timestamp is in the future';
        if (expiresAt <= timestamp) return 'Login challenge expiresAt must be after timestamp';
        if (expiresAt <= now) return 'Login challenge is expired';

        const requestedMaxAge = options && options.maxAgeMs;
        const maxAgeMs = Number.isFinite(requestedMaxAge) && requestedMaxAge > 0
            ? Math.min(requestedMaxAge, LOGIN_MAX_AGE_MS)
            : LOGIN_MAX_AGE_MS;
        if (now - timestamp > maxAgeMs) return 'Login challenge is too old';
        return null;
    } catch (error) {
        return 'Invalid login challenge';
    }
}

module.exports = {
    LOGIN_MAX_AGE_MS,
    parseLoginChallenge,
    checkLoginChallenge,
};
