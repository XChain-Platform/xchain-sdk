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
const errors = require('../../src/errors.js');

const {
    SDKError,
    SDKValidationError, SDKFormatError, SDKEncoderError, SDKExplorerError,
    SDKHubError, SDKConfigError, SDKContractError, SDKWalletError,
    SDKAuthError, SDKMessagingError, SDKActionError, SDKMuSigError, SDKGatedFileError,
} = errors;

describe('SDK error classes', function () {

    it('SDKError carries code, message, and details and extends Error', function () {
        const e = new SDKError('E_CODE', 'boom', { a: 1 });
        assert.ok(e instanceof Error);
        assert.strictEqual(e.name, 'SDKError');
        assert.strictEqual(e.code, 'E_CODE');
        assert.strictEqual(e.message, 'boom');
        assert.deepStrictEqual(e.details, { a: 1 });
    });

    it('SDKError defaults details to an empty object', function () {
        const e = new SDKError('E', 'msg');
        assert.deepStrictEqual(e.details, {});
    });

    // Every subclass: same shape, its own `name`, instanceof both itself and SDKError.
    const subclasses = [
        ['SDKValidationError', SDKValidationError],
        ['SDKFormatError',     SDKFormatError],
        ['SDKEncoderError',    SDKEncoderError],
        ['SDKExplorerError',   SDKExplorerError],
        ['SDKHubError',        SDKHubError],
        ['SDKConfigError',     SDKConfigError],
        ['SDKContractError',   SDKContractError],
        ['SDKWalletError',     SDKWalletError],
        ['SDKAuthError',       SDKAuthError],
        ['SDKMessagingError',  SDKMessagingError],
        ['SDKActionError',     SDKActionError],
        ['SDKMuSigError',      SDKMuSigError],
        ['SDKGatedFileError',  SDKGatedFileError],
    ];

    for (const [name, Cls] of subclasses) {
        it(`${name} sets name='${name}', extends SDKError, preserves code/message/details`, function () {
            const e = new Cls('C1', 'the message', { k: 'v' });
            assert.ok(e instanceof SDKError, `${name} should extend SDKError`);
            assert.ok(e instanceof Error);
            assert.strictEqual(e.name, name);
            assert.strictEqual(e.code, 'C1');
            assert.strictEqual(e.message, 'the message');
            assert.deepStrictEqual(e.details, { k: 'v' });
        });

        it(`${name} defaults details to {}`, function () {
            const e = new Cls('C2', 'm');
            assert.deepStrictEqual(e.details, {});
        });
    }

    // SDKRateLimitedError is not in the list above: its constructor takes
    // (message, details) and forces code 'RATE_LIMITED', because a rate limit
    // is one condition rather than a family of codes.
    it('SDKRateLimitedError forces code RATE_LIMITED and lifts the three fields out of details', function () {
        const e = new errors.SDKRateLimitedError('Explorer returned HTTP 429 for /BTC/api/status; retry after 30 seconds', {
            service: 'explorer', status: 429, retryAfterSeconds: 30, url: '/BTC/api/status', data: { error: 'slow down' }
        });
        assert.ok(e instanceof SDKError, 'SDKRateLimitedError should extend SDKError');
        assert.ok(e instanceof Error);
        assert.strictEqual(e.name, 'SDKRateLimitedError');
        assert.strictEqual(e.code, 'RATE_LIMITED');
        assert.strictEqual(e.message, 'Explorer returned HTTP 429 for /BTC/api/status; retry after 30 seconds');
        assert.strictEqual(e.service, 'explorer');
        assert.strictEqual(e.status, 429);
        assert.strictEqual(e.retryAfterSeconds, 30);
        assert.strictEqual(e.details.url, '/BTC/api/status');
        assert.deepStrictEqual(e.details.data, { error: 'slow down' });
    });

    it('SDKRateLimitedError defaults retryAfterSeconds to null and status to 429', function () {
        const e = new errors.SDKRateLimitedError('Encoder returned HTTP 429 for method ping');
        assert.strictEqual(e.retryAfterSeconds, null);
        assert.strictEqual(e.status, 429);
        assert.strictEqual(e.service, null);
        assert.deepStrictEqual(e.details, {});
    });

    it('SDKRateLimitedError is NOT an explorer/encoder error, so a caller can catch it apart', function () {
        const e = new errors.SDKRateLimitedError('m', { service: 'explorer' });
        assert.ok(!(e instanceof errors.SDKExplorerError));
        assert.ok(!(e instanceof errors.SDKEncoderError));
    });

    it('a subclass is throwable and catchable as SDKError', function () {
        assert.throws(
            () => { throw new SDKHubError('HUB_DOWN', 'unreachable'); },
            (err) => err instanceof SDKError && err.name === 'SDKHubError' && err.code === 'HUB_DOWN'
        );
    });
});
