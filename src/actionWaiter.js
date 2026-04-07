/*********************************************************************
 *
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 *
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided "AS IS", without warranties or conditions of any kind.
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
                        if (requireValid && msg.data.status === 'invalid') {
                            settle(new SDKActionError('ACTION_REJECTED',
                                'Action was indexed but marked invalid',
                                { txid, action: msg.data }));
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
                    let result = await explorer.getTransaction(txid, 'hash');
                    if (result && result.tx_hash) {
                        if (requireValid && result.status === 'invalid') {
                            settle(new SDKActionError('ACTION_REJECTED',
                                'Action was indexed but marked invalid',
                                { txid, action: result, reason: result.status_description || null }));
                        } else {
                            settle(null, result);
                        }
                    }
                } catch (e) {
                    // 404 or network error — keep polling
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
