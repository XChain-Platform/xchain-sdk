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

    it('a subclass is throwable and catchable as SDKError', function () {
        assert.throws(
            () => { throw new SDKHubError('HUB_DOWN', 'unreachable'); },
            (err) => err instanceof SDKError && err.name === 'SDKHubError' && err.code === 'HUB_DOWN'
        );
    });
});
