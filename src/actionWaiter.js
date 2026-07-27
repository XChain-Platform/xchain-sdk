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

// Warn-once guard for an action the indexer exposes with no status at all.
// Once per process: BET cancel/resolve legs hit this on every wait, and a
// per-wait warning would drown the useful one.
let warnedUnknownStatus = false;

// A per-action status is only evidence when the indexer actually reported one.
// null / undefined / '' mean "not recorded or not exposed", NOT "valid".
function readStatus(action) {
    if (!action) return null;
    if (typeof action.status !== 'string') return null;
    let status = action.status.trim();
    return status === '' ? null : status;
}


class ActionWaiter {

    // opts.explorer     - an explorer client to poll INSTEAD of sdk.explorer
    // opts.explorerUrl  - host/URL to build one from (with opts.explorerPort)
    //
    // Why: the waiter used to poll sdk.explorer unconditionally, and hub
    // discovery points that at whatever explorer the shared stack advertises.
    // On an ISOLATED regtest venue (its own node/decoder/indexer, no colocated
    // explorer) every SDK-driven action then polls a stranger's explorer that
    // will never see the transaction, and the whole run dies on
    // CONFIRMATION_TIMEOUT with nothing wrong on-chain (, from the
    //  A2 drill). Injecting the target lets one driver keep the shared
    // SDK for encoding/broadcast while waiting on the venue that actually
    // indexed the transaction.
    constructor(sdk, opts = {}) {
        this.sdk = sdk;
        this.explorer = ActionWaiter._buildExplorer(sdk, opts);
    }

    // Explorer override from { explorer } or { explorerUrl, explorerPort },
    // or null when neither is supplied. Network/timeout default to the SDK's
    // own so an override only changes the TARGET, never the coin prefix.
    static _buildExplorer(sdk, opts) {
        if (!opts) return null;
        if (opts.explorer) return opts.explorer;
        if (!opts.explorerUrl && !opts.explorerPort) return null;
        const ExplorerClient = require('./explorer.js');
        let sdkOpts = (sdk && sdk.options) || {};
        return new ExplorerClient({
            network:      opts.network      || sdkOpts.network || (sdk && sdk.network),
            explorerUrl:  opts.explorerUrl  || 'localhost',
            explorerPort: opts.explorerPort !== undefined ? parseInt(opts.explorerPort) : undefined,
            timeout:      opts.explorerTimeout || sdkOpts.timeout
        });
    }

    // Explorer this wait polls: per-call override, then the constructor
    // override, then the SDK's own (which throws when unconfigured).
    _resolveExplorer(opts) {
        let perCall = ActionWaiter._buildExplorer(this.sdk, opts);
        return perCall || this.explorer || this.sdk._requireExplorer();
    }

    // True when this wait reads an explorer other than the SDK's own. The
    // SDK's WebSocket follows the SDK's explorer, so its events describe a
    // DIFFERENT stack: a targeted wait could otherwise settle from a foreign
    // event. Overridden waits poll only.
    _explorerOverridden(opts) {
        return !!(ActionWaiter._buildExplorer(this.sdk, opts) || this.explorer);
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
    //   explorer     - explorer client to poll instead of the SDK's own; or pass
    //                  explorerUrl (+ explorerPort) to build one. Needed on
    //                  isolated stacks whose explorer is not the one hub
    //                  discovery advertises . An overridden wait skips
    //                  the SDK WebSocket fast path (it follows the OTHER stack)
    //                  and polls only.
    //   strictStatus - if true, requireValid also refuses to ASSUME validity: a wait
    //                  that could never read a status for the action rejects
    //                  ACTION_STATUS_UNKNOWN at the timeout instead of resolving.
    //                  Off by default (an unreadable status is not evidence of a
    //                  rejection), but the only fail-closed setting for a caller
    //                  that must not mistake silence for success .
    //
    // The resolved result carries the read itself, not just its conclusion:
    //   status              - normalized top-level status (see the poll comments)
    //   statusKnown         - true only when EVERY action in the target set carried
    //                         an explicit indexer status
    //   statusSource        - 'indexer' when statusKnown, otherwise 'assumed'
    //   statusUnknownActions- action_index values whose status could not be read
    async waitForTxid(txid, opts = {}) {
        let timeout      = opts.timeout || 120000;
        let pollInterval = opts.pollInterval || 2000;
        let requireValid = opts.requireValid !== false;
        let strictStatus = opts.strictStatus === true;
        // Resolve ONCE, outside the poll loop: a per-call explorerUrl would
        // otherwise build a fresh client (and a fresh keep-alive agent) on
        // every poll tick.
        let explorerTarget = this._resolveExplorer(opts);
        let useWebSocket   = !this._explorerOverridden(opts);

        return new Promise((resolve, reject) => {
            let settled  = false;
            let timer    = null;
            let pollId   = null;
            let unsub    = null;
            // Last result whose status could not be read; only used to explain a
            // strictStatus timeout with the action that stayed silent.
            let unknownResult = null;

            let settle = (err, result) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                if (pollId) clearInterval(pollId);
                if (unsub) { try { unsub(); } catch (e) {} }
                if (err) reject(err);
                else resolve(result);
            };

            // Timeout. A strictStatus wait that DID see the transaction but never
            // read a status reports that specifically: the transaction is indexed,
            // so "timed out waiting to be indexed" would send the caller hunting
            // the wrong problem.
            timer = setTimeout(() => {
                if (strictStatus && requireValid && unknownResult) {
                    settle(new SDKActionError('ACTION_STATUS_UNKNOWN',
                        'Transaction ' + txid + ' is indexed but the indexer reported no status for action(s) ' +
                        JSON.stringify(unknownResult.statusUnknownActions) + '; refusing to assume valid',
                        { txid, action: unknownResult, actions: unknownResult.statusUnknownActions }));
                    return;
                }
                settle(new SDKActionError('CONFIRMATION_TIMEOUT',
                    'Timed out waiting for transaction ' + txid + ' to be indexed (' + timeout + 'ms)',
                    { txid, timeout }));
            }, timeout);

            // Polling fallback (runs simultaneously with WebSocket). Defined before
            // the WS handler because the untargeted (whole-tx) WS path delegates to
            // it: see the handler comment below.
            let poll = async () => {
                if (settled) return;
                try {
                    let explorer = explorerTarget;
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
                            ? actions.filter(a => Number(a.action_index) === Number(opts.actionIndex))
                            : actions;

                        // : an EMPTY target set is not a verdict. A targeted wait whose
                        // action_index is not in the transaction (yet), or a transaction the
                        // explorer returns before its action rows exist, used to fall through
                        // the "no invalid found" branch and resolve reporting 'valid' - the
                        // caller could not tell a rejection from a success. Keep polling; the
                        // honest outcome when it never appears is the timeout above.
                        if (targetActions.length === 0) return;

                        let invalid = targetActions.find(a => { let s = readStatus(a); return s !== null && /^invalid/i.test(s); });
                        // Surface a normalized top-level status for callers/tests: the first
                        // action whose status is not 'valid'. This covers wire rejections
                        // ("invalid: ...") AND VM execution outcomes ('failed' / 'reverted' /
                        // 'out_of_resource'). Previously only "invalid:" surfaced, so a failed
                        // contract execution read as top-level 'valid' and callers had to dig
                        // into actions[n].status. Note requireValid still rejects ONLY on
                        // "invalid:"; an indexed-but-failed execution is a successful
                        // SUBMISSION (the tx is on-chain and processed), so flows that wait on
                        // delivery (attestation callbacks, batch drivers) must not throw.
                        let nonValid = targetActions.find(a => { let s = readStatus(a); return s !== null && s !== 'valid'; });
                        // Actions the indexer exposes with NO status (the indexer writes a parse
                        // status onto the action's own typed row, and some legs - BET cancel and
                        // resolve, for instance - write no row at all). 'valid' there is an
                        // ASSUMPTION, so it is labelled as one rather than sold as a chain read.
                        let unknown = targetActions.filter(a => readStatus(a) === null)
                                                   .map(a => a.action_index);
                        result.status              = nonValid ? nonValid.status : 'valid';
                        result.statusKnown         = unknown.length === 0;
                        result.statusSource        = result.statusKnown ? 'indexer' : 'assumed';
                        result.statusUnknownActions = unknown;

                        if (requireValid && invalid) {
                            let reason = readStatus(invalid);
                            settle(new SDKActionError('ACTION_REJECTED',
                                'Action was indexed but marked invalid: ' + reason,
                                { txid, action: result, reason }));
                            return;
                        }
                        if (!result.statusKnown) {
                            unknownResult = result;
                            // A fail-closed caller waits out the window: the status may still
                            // be written (indexer enrichment lags the transaction row), and
                            // only the timeout can prove it never was.
                            if (requireValid && strictStatus) return;
                            if (!warnedUnknownStatus) {
                                warnedUnknownStatus = true;
                                console.warn('[xchain-sdk] the indexer reported no status for action(s) ' +
                                    JSON.stringify(unknown) + ' of transaction ' + txid +
                                    '; reporting status=valid is an ASSUMPTION (result.statusKnown=false). ' +
                                    'Pass strictStatus:true to fail closed instead.');
                            }
                        }
                        settle(null, result);
                    }
                } catch (e) {
                    // 404 or network error; keep polling
                }
            };

            // Try WebSocket fast path (if connected). A live WS emits one NEW_ACTION
            // per action in the tx.
            if (useWebSocket && this.sdk.ws && this.sdk.ws.isConnected()) {
                let handler = (msg) => {
                    if (!(msg && msg.data && msg.data.tx_hash === txid)) return;

                    if (opts.actionIndex !== undefined) {
                        // Targeted wait: this event must be the requested action. A
                        // multi-action tx emits one NEW_ACTION per action; without
                        // this filter a neighboring action's event would settle the
                        // wait with the WRONG action's status, masking the target
                        // action's rejection as success. A non-matching event is
                        // ignored; the target action's event, or the poll fallback,
                        // settles.
                        if (Number(msg.data.action_index) !== Number(opts.actionIndex)) return;
                        // An event without a status settles NOTHING : resolving from
                        // it would report success the indexer never claimed. Defer to the
                        // authoritative poll, which reads the full action row.
                        let eventStatus = readStatus(msg.data);
                        if (eventStatus === null) { poll(); return; }
                        // Indexer status strings are prefixed, e.g. "invalid: insufficient funds (FEE)".
                        if (requireValid && /^invalid/i.test(eventStatus)) {
                            settle(new SDKActionError('ACTION_REJECTED',
                                'Action was indexed but marked invalid: ' + eventStatus,
                                { txid, action: msg.data, reason: eventStatus }));
                        } else {
                            // Copy rather than mutate: the same event object is handed to every
                            // other NEW_ACTION listener on this socket.
                            settle(null, Object.assign({}, msg.data, {
                                status:              eventStatus,
                                statusKnown:         true,
                                statusSource:        'indexer',
                                statusUnknownActions: []
                            }));
                        }
                        return;
                    }

                    // Untargeted (whole-tx) wait: a single NEW_ACTION event cannot
                    // prove the WHOLE tx succeeded, because a multi-action tx (BATCH,
                    // or any tx the lifecycle manager submits and waits on without an
                    // actionIndex) emits one event per action and a sibling action may
                    // be invalid. Settling success from one valid event here would
                    // mask a sibling's rejection - the poll path, which evaluates the
                    // FULL action set, would have rejected. So use the event only as a
                    // signal that the tx is indexed and trigger an immediate
                    // authoritative poll; poll() is idempotent (guards on `settled`),
                    // so firing it once per sub-action event is safe.
                    poll();
                };
                this.sdk.ws.on('NEW_ACTION', handler);
                unsub = () => this.sdk.ws.off('NEW_ACTION', handler);
            }

            // Start polling after a short initial delay (give WebSocket a chance first)
            setTimeout(() => {
                if (settled) return;
                poll(); // immediate first poll
                pollId = setInterval(poll, pollInterval);
            }, 500);
        });
    }

    // Wait for a specific action_index to appear in the explorer.
    // Accepts the same explorer / explorerUrl override as waitForTxid.
    async waitForActionIndex(actionIndex, opts = {}) {
        let timeout      = opts.timeout || 120000;
        let pollInterval = opts.pollInterval || 2000;
        let explorerTarget = this._resolveExplorer(opts);

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
                    let explorer = explorerTarget;
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
