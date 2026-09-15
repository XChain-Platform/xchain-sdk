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

const { SDKActionError } = require('../errors.js');

// Normalize only explicit indexer statuses so absent values remain distinguishable.
function readStatus(action) {
    if (!action) return null;
    if (typeof action.status !== 'string') return null;
    let status = action.status.trim();
    return status === '' ? null : status;
}

// Classify a transaction synchronously so the polling closure retains its await boundary.
function classifyTransactionResult(result, opts) {
    let actions = Array.isArray(result.actions) ? result.actions : [];
    let targetActions = (opts.actionIndex !== undefined)
        ? actions.filter(a => opts.sameWireIndex(a.action_index, opts.actionIndex))
        : actions;

    if (targetActions.length === 0) return { empty: true };

    let invalid = targetActions.find(a => {
        let status = readStatus(a);
        return status !== null && /^invalid/i.test(status);
    });
    let nonValid = targetActions.find(a => {
        let status = readStatus(a);
        return status !== null && status !== 'valid';
    });
    let unknown = targetActions.filter(a => readStatus(a) === null)
                               .map(a => a.action_index);
    result.status               = nonValid ? nonValid.status : 'valid';
    result.statusKnown          = unknown.length === 0;
    result.statusSource         = result.statusKnown ? 'indexer' : 'assumed';
    result.statusUnknownActions = unknown;

    return { empty: false, invalid, unknown };
}

// Build the strict-status timeout error without moving the timer callback.
function unknownStatusError(txid, result) {
    return new SDKActionError('ACTION_STATUS_UNKNOWN',
        'Transaction ' + txid + ' is indexed but the indexer reported no status for action(s) ' +
        JSON.stringify(result.statusUnknownActions) + '; refusing to assume valid',
        { txid, action: result, actions: result.statusUnknownActions });
}

// Build the confirmation timeout error without moving the timer callback.
function confirmationTimeoutError(txid, timeout) {
    return new SDKActionError('CONFIRMATION_TIMEOUT',
        'Transaction ' + txid + ' was not indexed within ' + timeout + 'ms. ' +
        'It may still be in the mempool awaiting a block; check the transaction ' +
        'before rebuilding it, since re-sending would spend the same inputs again.',
        { txid, timeout });
}

// Build a rejection error consistently for poll and event results.
function actionRejectedError(txid, action, reason) {
    return new SDKActionError('ACTION_REJECTED',
        'Action was indexed but marked invalid: ' + reason,
        { txid, action, reason });
}

// Copy an event result so other socket listeners retain the original object.
function targetedEventResult(data, eventStatus) {
    return Object.assign({}, data, {
        status:               eventStatus,
        statusKnown:          true,
        statusSource:         'indexer',
        statusUnknownActions: []
    });
}

// Classify one socket event synchronously so the registered handler stays inline.
function classifyTargetedEvent(data, actionIndex, requireValid, txid, sameWireIndex) {
    // A multi-action transaction emits one event per action, so neighboring
    // indices must not settle a targeted wait.
    if (!sameWireIndex(data.action_index, actionIndex)) return { ignored: true };
    // An event without status is not a verdict; the authoritative poll reads
    // the full action row and decides whether the wait can settle.
    let eventStatus = readStatus(data);
    if (eventStatus === null) return { poll: true };
    if (requireValid && /^invalid/i.test(eventStatus)) {
        return { error: actionRejectedError(txid, data, eventStatus) };
    }
    return { result: targetedEventResult(data, eventStatus) };
}

// Build the warn-once text without moving the process-level state write.
function unknownStatusWarning(txid, unknown) {
    return '[xchain-sdk] the indexer reported no status for action(s) ' +
        JSON.stringify(unknown) + ' of transaction ' + txid +
        '; reporting status=valid is an ASSUMPTION (result.statusKnown=false). ' +
        'Pass strictStatus:true to fail closed instead.';
}

module.exports = {
    readStatus,
    classifyTransactionResult,
    unknownStatusError,
    confirmationTimeoutError,
    actionRejectedError,
    targetedEventResult,
    classifyTargetedEvent,
    unknownStatusWarning
};
