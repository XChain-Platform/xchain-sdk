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
 **********************************************************************
 *
 * XChain Platform SDK - Action Waiter
 *
 * Resolves when the indexer processes a specific transaction.
 * Uses WebSocket events with polling fallback.
 *
 ********************************************************************/

const { SDKActionError, SDKConfigError } = require('../errors.js');

// Validate the state gate before any explorer read can begin.
function validateStateArgs(contractActionIndex, opts) {
    if (contractActionIndex === undefined || contractActionIndex === null || contractActionIndex === '')
        throw new SDKConfigError('MISSING_CONTRACT_INDEX',
            'waitForContractState requires a contract ACTION_INDEX');
    if (opts.equals !== undefined && opts.key === undefined)
        throw new SDKConfigError('MISSING_CONTRACT_STATE_KEY',
            'waitForContractState opts.equals needs opts.key to say WHICH key must hold it');
    if (opts.key === undefined && typeof opts.match !== 'function')
        throw new SDKConfigError('MISSING_CONTRACT_STATE_CONDITION',
            'waitForContractState needs opts.key (optionally with opts.equals) or opts.match; ' +
            'without one it would resolve on the first read and gate nothing');
}

// Classify a state read synchronously after the explorer await completes.
function classifyState(ActionWaiter, raw, key, opts, contractActionIndex, sameStateValue) {
    let state = ActionWaiter.normalizeContractState(raw);
    let value = (key === undefined) ? undefined
              : ActionWaiter.readContractStateValue(raw, key);
    let ctx   = { contractActionIndex, key, value, state, raw };

    let satisfied;
    if (typeof opts.match === 'function')      satisfied = !!opts.match(state, ctx);
    else if (opts.equals !== undefined)        satisfied = sameStateValue(value, opts.equals);
    else                                       satisfied = value !== undefined && value !== null;

    return { satisfied, result: ctx, observed: state };
}

// Validate the balance gate before any explorer read can begin.
function validateBalanceArgs(contractActionIndex, tick) {
    if (contractActionIndex === undefined || contractActionIndex === null || contractActionIndex === '')
        throw new SDKConfigError('MISSING_CONTRACT_INDEX',
            'waitForContractBalance requires a contract ACTION_INDEX');
    if (!tick)
        throw new SDKConfigError('MISSING_TICK', 'waitForContractBalance requires a tick');
}

// Normalize the optional minimum without losing decimal precision.
function minimumQuantity(opts) {
    return (opts.minQuantity === undefined || opts.minQuantity === null || opts.minQuantity === '')
        ? null : String(opts.minQuantity);
}

// Classify a balance read synchronously after the explorer await completes.
function classifyBalance(ActionWaiter, raw, tick, opts, contractActionIndex, minimum, compareAmount) {
    let quantity = ActionWaiter.readContractQuantity(raw, tick);
    let ctx      = { contractActionIndex, tick, quantity, raw };

    let satisfied;
    if (typeof opts.match === 'function')  satisfied = !!opts.match(quantity, ctx);
    else if (minimum !== null)             satisfied = quantity !== null && compareAmount(quantity, minimum) >= 0;
    else                                   satisfied = quantity !== null && compareAmount(quantity, '0') > 0;

    return { satisfied, result: ctx, observed: quantity };
}

// Build the balance timeout error without moving the timeout callback.
function balanceTimeoutError(contractActionIndex, tick, opts, minimum, observed, lastError) {
    return new SDKActionError('CONTRACT_BALANCE_TIMEOUT',
        'Contract ' + contractActionIndex + ' did not hold the expected ' + tick +
        ' balance within ' + (opts.timeout > 0 ? opts.timeout : 120000) + 'ms' +
        (minimum !== null ? ' (wanted at least ' + minimum + ', last read ' + observed + ')' : '') + '. ' +
        'The deposit may be indexed but not yet credited to the contract.',
        { contractActionIndex, tick, minQuantity: minimum, quantity: observed,
          timeout: opts.timeout, cause: lastError || undefined });
}

module.exports = {
    validateStateArgs,
    classifyState,
    validateBalanceArgs,
    minimumQuantity,
    classifyBalance,
    balanceTimeoutError
};
