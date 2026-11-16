// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('assert');
const {
    validateAssemblyArgs,
    classifyAssembly,
    assemblyTimeoutError
} = require('../../../../src/utils/action_waiter/file_assembly_wait.js');
const { SDKActionError, SDKConfigError } = require('../../../../src/utils/errors.js');

describe('file assembly argument validation', function () {
    it('rejects undefined, null and empty file action indexes', function () {
        for (const index of [undefined, null, '']) {
            assert.throws(() => validateAssemblyArgs(index), error => {
                assert.ok(error instanceof SDKConfigError);
                assert.strictEqual(error.code, 'MISSING_FILE_ACTION_INDEX');
                return true;
            });
        }
    });

    it('accepts a supplied file action index', function () {
        assert.doesNotThrow(() => validateAssemblyArgs('action-1'));
    });
});

describe('file assembly classification', function () {
    for (const status of ['complete', 'mismatch']) {
        it('satisfies terminal ' + status + ' assembly status', function () {
            const multipart = {
                file_hash: 'ab'.repeat(32),
                total_parts: 3,
                parts_received: 3,
                total_bytes: 1024,
                status
            };
            const outcome = classifyAssembly(multipart, 'action-1');

            assert.strictEqual(outcome.satisfied, true);
            assert.strictEqual(outcome.result.actionIndex, 'action-1');
            assert.strictEqual(outcome.result.multipart, multipart);
            assert.strictEqual(outcome.observed, multipart);
        });
    }

    it('does not satisfy pending assembly status', function () {
        const multipart = { total_parts: 3, parts_received: 2, status: 'pending' };
        const outcome = classifyAssembly(multipart, 'action-1');

        assert.strictEqual(outcome.satisfied, false);
        assert.strictEqual(outcome.result.multipart, multipart);
        assert.strictEqual(outcome.observed, multipart);
    });

    it('does not satisfy a null read', function () {
        const outcome = classifyAssembly(null, 'action-1');

        assert.strictEqual(outcome.satisfied, false);
        assert.strictEqual(outcome.result.multipart, null);
        assert.strictEqual(outcome.observed, null);
    });
});

describe('file assembly timeout error', function () {
    it('builds a typed error with the last assembly read and cause', function () {
        const observed = { total_parts: 5, parts_received: 3, status: 'pending' };
        const lastError = new Error('read failed');
        const error = assemblyTimeoutError('action-1', { timeout: 50 }, observed, lastError);

        assert.ok(error instanceof SDKActionError);
        assert.strictEqual(error.code, 'FILE_ASSEMBLY_TIMEOUT');
        assert.match(error.message, /3 of 5/);
        assert.strictEqual(error.details.actionIndex, 'action-1');
        assert.strictEqual(error.details.multipart, observed);
        assert.strictEqual(error.details.timeout, 50);
        assert.strictEqual(error.details.cause, lastError);
    });
});
