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

const { SDKActionError } = require('./errors.js');


class ActionWaiter {

    constructor(sdk) {
        this.sdk = sdk;
    }

    // Wait for a transaction (by tx_hash) to be indexed by the explorer
    // Returns the action object from the explorer, or rejects on timeout
    //
    // Options:
    //   timeout      - ms to wait before rejecting (default 120000)
    //   pollInterval - ms between explorer poll attempts (default 2000)
    //   requireValid - if true (default), reject if the action status is 'invalid'
    //   actionIndex  - when supplied, status is resolved from that specific action
    //                  only, preventing a neighboring action's status from leaking
    //                  into the result (relevant for multi-action transactions)
    async waitForTxid(txid, opts = {}) {
        let timeout      = opts.timeout || 120000;
        let pollInterval = opts.pollInterval || 2000;
        let requireValid = opts.requireValid !== false;

        return new Promise((resolve, reject) => {
            let settled  = false;
            let timer    = null;
            let pollId   = null;
            let unsub    = null;

            let settle = (err, result) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                if (pollId) clearInterval(pollId);
                if (unsub) { try { unsub(); } catch (e) {} }
                if (err) reject(err);
                else resolve(result);
            };

            // Timeout
            timer = setTimeout(() => {
                settle(new SDKActionError('CONFIRMATION_TIMEOUT',
                    'Timed out waiting for transaction ' + txid + ' to be indexed (' + timeout + 'ms)',
                    { txid, timeout }));
            }, timeout);

            // Try WebSocket fast path (if connected)
            if (this.sdk.ws && this.sdk.ws.isConnected()) {
                let handler = (msg) => {
                    if (msg && msg.data && msg.data.tx_hash === txid) {
                        // Honor opts.actionIndex on the WS path too (the poll path
                        // already narrows to it). A multi-action tx emits one
                        // NEW_ACTION per action; without this filter a neighboring
                        // action's event would settle the wait with the WRONG
                        // action's status, defeating the actionIndex guard and
                        // possibly masking the target action's rejection as success.
                        // A non-matching (or action_index-less) event is ignored; the
                        // target action's event, or the poll fallback, settles.
                        if (opts.actionIndex !== undefined &&
                            Number(msg.data.action_index) !== Number(opts.actionIndex)) {
                            return;
                        }
                        // Indexer status strings are prefixed, e.g. "invalid: insufficient funds (FEE)".
                        let invalid = typeof msg.data.status === 'string' && /^invalid/i.test(msg.data.status);
                        if (requireValid && invalid) {
                            settle(new SDKActionError('ACTION_REJECTED',
                                'Action was indexed but marked invalid: ' + msg.data.status,
                                { txid, action: msg.data, reason: msg.data.status }));
                        } else {
                            settle(null, msg.data);
                        }
                    }
                };
                this.sdk.ws.on('NEW_ACTION', handler);
                unsub = () => this.sdk.ws.off('NEW_ACTION', handler);
            }

            // Polling fallback (runs simultaneously with WebSocket)
            let poll = async () => {
                if (settled) return;
                try {
                    let explorer = this.sdk._requireExplorer();
                    // The explorer transaction endpoint keys on type 'tx_hash' (not 'hash')
                    // and returns { tx_hash, block_index, actions: [{ action, status, ... }], ... }.
                    // Per-action status is prefixed, e.g. "valid" / "invalid: insufficient funds (FEE)".
                    let result = await explorer.getTransaction(txid, 'tx_hash');
                    if (result && result.tx_hash) {
                        let actions = Array.isArray(result.actions) ? result.actions : [];

                        // If a specific action_index was requested, narrow the action list to
                        // that entry only. This prevents a neighboring action's status from
                        // surfacing as the top-level result in multi-action transactions.
                        let targetActions = (opts.actionIndex !== undefined)
                            ? actions.filter(a => a.action_index === opts.actionIndex)
                            : actions;

                        let invalid = targetActions.find(a => typeof a.status === 'string' && /^invalid/i.test(a.status));
                        // Surface a normalized top-level status for callers/tests: the first
                        // action whose status is not 'valid'. This covers wire rejections
                        // ("invalid: ...") AND VM execution outcomes ('failed' / 'reverted' /
                        // 'out_of_resource'). Previously only "invalid:" surfaced, so a failed
                        // contract execution read as top-level 'valid' and callers had to dig
                        // into actions[n].status. Note requireValid still rejects ONLY on
                        // "invalid:"; an indexed-but-failed execution is a successful
                        // SUBMISSION (the tx is on-chain and processed), so flows that wait on
                        // delivery (attestation callbacks, batch drivers) must not throw.
                        let nonValid = targetActions.find(a => typeof a.status === 'string' && a.status !== 'valid');
                        result.status = nonValid ? nonValid.status : 'valid';
                        if (requireValid && invalid) {
                            settle(new SDKActionError('ACTION_REJECTED',
                                'Action was indexed but marked invalid: ' + invalid.status,
                                { txid, action: result, reason: invalid.status }));
                        } else {
                            settle(null, result);
                        }
                    }
                } catch (e) {
                    // 404 or network error; keep polling
                }
            };

            // Start polling after a short initial delay (give WebSocket a chance first)
            setTimeout(() => {
                if (settled) return;
                poll(); // immediate first poll
                pollId = setInterval(poll, pollInterval);
            }, 500);
        });
    }

    // Wait for a specific action_index to appear in the explorer
    async waitForActionIndex(actionIndex, opts = {}) {
        let timeout      = opts.timeout || 120000;
        let pollInterval = opts.pollInterval || 2000;

        return new Promise((resolve, reject) => {
            let settled = false;
            let timer   = null;
            let pollId  = null;

            let settle = (err, result) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                if (pollId) clearInterval(pollId);
                if (err) reject(err);
                else resolve(result);
            };

            timer = setTimeout(() => {
                settle(new SDKActionError('CONFIRMATION_TIMEOUT',
                    'Timed out waiting for action_index ' + actionIndex + ' (' + timeout + 'ms)',
                    { actionIndex, timeout }));
            }, timeout);

            let poll = async () => {
                if (settled) return;
                try {
                    let explorer = this.sdk._requireExplorer();
                    let result = await explorer.getAction(actionIndex);
                    if (result && result.action_index !== undefined) {
                        settle(null, result);
                    }
                } catch (e) {
                    // keep polling
                }
            };

            poll();
            pollId = setInterval(poll, pollInterval);
        });
    }

}

module.exports = ActionWaiter;
