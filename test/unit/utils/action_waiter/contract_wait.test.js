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
    validateStateArgs,
    classifyState,
    validateBalanceArgs,
    minimumQuantity,
    classifyBalance,
    balanceTimeoutError
} = require('../../../../src/utils/action_waiter/contract_wait.js');
const { SDKActionError, SDKConfigError } = require('../../../../src/utils/errors.js');

const ActionWaiter = {
    normalizeContractState: raw => raw.state,
    readContractStateValue: (raw, key) => raw.values[key],
    readContractQuantity: (raw, tick) => raw.quantities[tick]
};

function assertConfigError(run, code) {
    assert.throws(run, error => {
        assert.ok(error instanceof SDKConfigError);
        assert.strictEqual(error.code, code);
        return true;
    });
}

describe('contract state argument validation', function () {
    it('rejects undefined, null and empty contract indexes', function () {
        for (const index of [undefined, null, '']) {
            assertConfigError(
                () => validateStateArgs(index, { key: 'owner' }),
                'MISSING_CONTRACT_INDEX'
            );
        }
    });

    it('requires a key when equals supplies the condition', function () {
        assertConfigError(
            () => validateStateArgs('action-1', { equals: 'alice' }),
            'MISSING_CONTRACT_STATE_KEY'
        );
    });

    it('requires a key or match function', function () {
        assertConfigError(
            () => validateStateArgs('action-1', {}),
            'MISSING_CONTRACT_STATE_CONDITION'
        );
    });

    it('accepts a key without another condition', function () {
        assert.doesNotThrow(() => validateStateArgs('action-1', { key: 'owner' }));
    });
});

describe('contract state classification', function () {
    const raw = { state: { owner: 'alice' }, values: { owner: 'alice' } };

    it('satisfies a match function with normalized state and context', function () {
        let received;
        const outcome = classifyState(ActionWaiter, raw, undefined, {
            match: (state, context) => {
                received = { state, context };
                return state.owner === 'alice';
            }
        }, 'action-1', () => false);

        assert.strictEqual(outcome.satisfied, true);
        assert.deepStrictEqual(received.state, raw.state);
        assert.strictEqual(received.context.value, undefined);
        assert.strictEqual(received.context.contractActionIndex, 'action-1');
        assert.strictEqual(received.context.raw, raw);
        assert.deepStrictEqual(outcome.observed, raw.state);
    });

    it('satisfies equals through the injected comparator', function () {
        let compared;
        const outcome = classifyState(ActionWaiter, raw, 'owner', { equals: 'ALICE' },
            'action-1', (actual, expected) => {
                compared = [actual, expected];
                return actual.toUpperCase() === expected;
            });

        assert.strictEqual(outcome.satisfied, true);
        assert.deepStrictEqual(compared, ['alice', 'ALICE']);
    });

    it('satisfies an existing keyed value without another condition', function () {
        const outcome = classifyState(ActionWaiter, raw, 'owner', {}, 'action-1', () => false);

        assert.strictEqual(outcome.satisfied, true);
        assert.strictEqual(outcome.result.value, 'alice');
    });
});

describe('contract balance helpers', function () {
    it('rejects missing contract indexes and ticks', function () {
        for (const index of [undefined, null, '']) {
            assertConfigError(
                () => validateBalanceArgs(index, 'XCHAIN'),
                'MISSING_CONTRACT_INDEX'
            );
        }
        assertConfigError(() => validateBalanceArgs('action-1'), 'MISSING_TICK');
    });

    it('normalizes only supplied minimum quantities to strings', function () {
        assert.strictEqual(minimumQuantity({}), null);
        assert.strictEqual(minimumQuantity({ minQuantity: null }), null);
        assert.strictEqual(minimumQuantity({ minQuantity: '' }), null);
        assert.strictEqual(minimumQuantity({ minQuantity: 0 }), '0');
        assert.strictEqual(minimumQuantity({ minQuantity: 2.5 }), '2.5');
    });

    it('builds a typed timeout naming the tick and wanted minimum', function () {
        const error = balanceTimeoutError('action-1', 'XCHAIN', { timeout: 50 },
            '2.5', '1.25', new Error('read failed'));

        assert.ok(error instanceof SDKActionError);
        assert.strictEqual(error.code, 'CONTRACT_BALANCE_TIMEOUT');
        assert.match(error.message, /XCHAIN/);
        assert.match(error.message, /wanted at least 2\.5/);
    });
});

describe('contract balance classification', function () {
    const raw = { quantities: { XCHAIN: '2.5' } };

    it('satisfies a match function with quantity and context', function () {
        let received;
        const outcome = classifyBalance(ActionWaiter, raw, 'XCHAIN', {
            match: (quantity, context) => {
                received = { quantity, context };
                return quantity === '2.5';
            }
        }, 'action-1', null, () => -1);

        assert.strictEqual(outcome.satisfied, true);
        assert.strictEqual(received.quantity, '2.5');
        assert.strictEqual(received.context.contractActionIndex, 'action-1');
        assert.strictEqual(received.context.raw, raw);
        assert.strictEqual(outcome.observed, '2.5');
    });

    it('satisfies a minimum through the injected amount comparator', function () {
        let compared;
        const outcome = classifyBalance(ActionWaiter, raw, 'XCHAIN', {}, 'action-1', '2',
            (actual, expected) => {
                compared = [actual, expected];
                return Number(actual) - Number(expected);
            });

        assert.strictEqual(outcome.satisfied, true);
        assert.deepStrictEqual(compared, ['2.5', '2']);
    });

    it('satisfies a positive balance without another condition', function () {
        const outcome = classifyBalance(ActionWaiter, raw, 'XCHAIN', {}, 'action-1', null,
            (actual, expected) => Number(actual) - Number(expected));

        assert.strictEqual(outcome.satisfied, true);
        assert.strictEqual(outcome.result.quantity, '2.5');
    });
});
