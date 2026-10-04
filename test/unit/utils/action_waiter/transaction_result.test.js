/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const { SDKActionError } = require('../../../../src/utils/errors.js');
const {
    readStatus,
    classifyTransactionResult,
    unknownStatusError,
    confirmationTimeoutError,
    actionRejectedError,
    classifyTargetedEvent
} = require('../../../../src/utils/action_waiter/transaction_result.js');

const sameWireIndex = (left, right) => left === right;

describe('transaction result classification', function () {
    it('normalizes explicit statuses and rejects absent statuses', function () {
        assert.strictEqual(readStatus({ status: '  valid  ' }), 'valid');
        assert.strictEqual(readStatus(), null);
        assert.strictEqual(readStatus({ status: 7 }), null);
        assert.strictEqual(readStatus({ status: '   ' }), null);
    });

    it('reports an empty result when no actions can be classified', function () {
        assert.deepStrictEqual(classifyTransactionResult({}, {}), { empty: true });
        assert.deepStrictEqual(classifyTransactionResult({
            actions: [{ action_index: 2, status: 'valid' }]
        }, { actionIndex: 3, sameWireIndex }), { empty: true });
    });

    it('finds the first invalid action and the first non-valid status', function () {
        const pending = { action_index: 0, status: 'pending' };
        const firstInvalid = { action_index: 1, status: 'invalid: rejected' };
        const result = { actions: [pending, firstInvalid,
            { action_index: 2, status: 'invalid: later' }] };
        const classification = classifyTransactionResult(result, {});

        assert.strictEqual(classification.empty, false);
        assert.strictEqual(classification.invalid, firstInvalid);
        assert.strictEqual(result.status, 'pending');
        assert.strictEqual(result.statusKnown, true);
        assert.strictEqual(result.statusSource, 'indexer');
        assert.deepStrictEqual(result.statusUnknownActions, []);
    });

    it('assumes valid while identifying actions without a status', function () {
        const result = { actions: [
            { action_index: 4, status: 'valid' },
            { action_index: 5 }
        ] };
        const classification = classifyTransactionResult(result, {});

        assert.strictEqual(classification.invalid, undefined);
        assert.deepStrictEqual(classification.unknown, [5]);
        assert.strictEqual(result.status, 'valid');
        assert.strictEqual(result.statusKnown, false);
        assert.strictEqual(result.statusSource, 'assumed');
        assert.deepStrictEqual(result.statusUnknownActions, [5]);
    });
});

describe('targeted event classification', function () {
    it('ignores an event for another action index', function () {
        assert.deepStrictEqual(classifyTargetedEvent(
            { action_index: 1, status: 'valid' }, 2, true, 'txid', sameWireIndex
        ), { ignored: true });
    });

    it('polls when the targeted event has a blank status', function () {
        assert.deepStrictEqual(classifyTargetedEvent(
            { action_index: 2, status: '  ' }, 2, true, 'txid', sameWireIndex
        ), { poll: true });
    });

    it('returns a rejection error when validity is required', function () {
        const action = { action_index: 2, status: 'invalid: denied' };
        const classification = classifyTargetedEvent(
            action, 2, true, 'txid', sameWireIndex
        );

        assert.ok(classification.error instanceof SDKActionError);
        assert.strictEqual(classification.error.code, 'ACTION_REJECTED');
        assert.strictEqual(classification.error.details.action, action);
    });

    it('returns a known-status result for a targeted event', function () {
        const data = { action_index: 2, status: ' valid ', value: 10 };
        const classification = classifyTargetedEvent(
            data, 2, false, 'txid', sameWireIndex
        );

        assert.notStrictEqual(classification.result, data);
        assert.strictEqual(classification.result.status, 'valid');
        assert.strictEqual(classification.result.statusKnown, true);
        assert.strictEqual(classification.result.statusSource, 'indexer');
        assert.deepStrictEqual(classification.result.statusUnknownActions, []);
    });
});

describe('transaction result errors', function () {
    it('builds typed errors with their public codes', function () {
        const result = { statusUnknownActions: [3] };
        const errors = [
            unknownStatusError('txid', result),
            confirmationTimeoutError('txid', 5000),
            actionRejectedError('txid', result, 'invalid')
        ];

        assert.deepStrictEqual(errors.map(error => error.code), [
            'ACTION_STATUS_UNKNOWN',
            'CONFIRMATION_TIMEOUT',
            'ACTION_REJECTED'
        ]);
        errors.forEach(error => assert.ok(error instanceof SDKActionError));
    });
});
