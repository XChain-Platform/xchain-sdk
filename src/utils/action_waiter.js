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
// Both targeted-wait filters below decide index identity with this, never with
// Number(): action_index arrives as a decimal string on the wire, and Number()
// collapses two adjacent indices above 2^53 onto one value, which is exactly the
// neighbouring action these filters exist to exclude.
const { sameWireIndex } = require('./wire_index.js');
const { getLogger } = require('../observability/logger.js');
const { buildExplorer } = require('./action_waiter/explorer_options.js');
const contractValues = require('./action_waiter/contract_values.js');
const contractWait = require('./action_waiter/contract_wait.js');
const {
    readStatus,
    classifyTransactionResult,
    unknownStatusError,
    confirmationTimeoutError,
    actionRejectedError,
    classifyTargetedEvent,
    unknownStatusWarning
} = require('./action_waiter/transaction_result.js');
const log = getLogger('xchain-sdk:action-waiter');

// Warn-once guard for an action the indexer exposes with no status at all.
// Once per process: BET cancel/resolve legs hit this on every wait, and a
// per-wait warning would drown the useful one.
let warnedUnknownStatus = false;

class ActionWaiter {

    // Keep encoding on the shared SDK while an optional target explorer watches
    // the venue that actually indexes the transaction. A discovered shared
    // explorer may describe another stack and can never confirm this venue's tx.
    constructor(sdk, opts = {}) {
        this.sdk = sdk;
        this.explorer = buildExplorer(sdk, opts);
    }

    // Explorer this wait polls: per-call override, then the constructor
    // override, then the SDK's own (which throws when unconfigured).
    resolveExplorer(opts) {
        let perCall = buildExplorer(this.sdk, opts);
        return perCall || this.explorer || this.sdk.requireExplorer();
    }

    // True when this wait reads an explorer other than the SDK's own. The
    // SDK's WebSocket follows the SDK's explorer, so its events describe a
    // DIFFERENT stack: a targeted wait could otherwise settle from a foreign
    // event. Overridden waits poll only.
    explorerOverridden(opts) {
        return !!(buildExplorer(this.sdk, opts) || this.explorer);
    }

    // Wait for a transaction by tx_hash and return its indexed action result.
    //
    // Options:
    //   timeout      - ms to wait before rejecting (default 120000)
    //   pollInterval - ms between explorer poll attempts (default 2000)
    //   requireValid - if true (default), reject if the action status is 'invalid'
    //   actionIndex  - restrict status resolution to one action
    //   explorer     - explorer client override; URL and port options also work
    //   strictStatus - reject at timeout when no explicit status was readable
    //
    // The result carries both the read and its status evidence:
    //   status              - normalized top-level status (see the poll comments)
    //   statusKnown         - true when every target action has explicit status
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
        let explorerTarget = this.resolveExplorer(opts);
        let useWebSocket   = !this.explorerOverridden(opts);

        return new Promise((resolve, reject) => {
            let settled  = false;
            let timer    = null;
            let pollId   = null;
            let unsub    = null;
            // Tracks the last unreadable result so the timeout error explains
            // which action remained silent in a strictStatus wait.
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
                    settle(unknownStatusError(txid, unknownResult));
                    return;
                }
                // Not indexed inside the window. Say what that does and does NOT
                // mean: the transaction may be sitting in the mempool waiting for a
                // block, which on a chain with long or irregular block times is the
                // ordinary case rather than a fault. Callers that broadcast it
                // themselves mark `broadcast` on this error (see lifecycleManager).
                settle(confirmationTimeoutError(txid, timeout));
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
                        let classification = classifyTransactionResult(result,
                            { actionIndex: opts.actionIndex, sameWireIndex });
                        if (classification.empty) return;

                        if (requireValid && classification.invalid) {
                            let reason = readStatus(classification.invalid);
                            settle(actionRejectedError(txid, result, reason));
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
                                log.warn(unknownStatusWarning(txid, classification.unknown));
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
                        let event = classifyTargetedEvent(msg.data, opts.actionIndex,
                            requireValid, txid, sameWireIndex);
                        if (event.ignored) return;
                        if (event.poll) { poll(); return; }
                        if (event.error) settle(event.error);
                        else settle(null, event.result);
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
        let explorerTarget = this.resolveExplorer(opts);

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

    // Contract state and balance gates wait for execution, which is later than
    // transaction confirmation and action-row visibility. Reading the contract's
    // own data avoids building on inputs whose pending action already spent them.

    // Poll `readOnce` until it reports satisfied, or the window expires.
    //
    // A failed read is not a verdict. The loop always reads once and carries its
    // last observation or error into the timeout callback.
    async pollUntil(opts, readOnce, timeoutError) {
        let timeout      = opts.timeout > 0 ? opts.timeout : 120000;
        let pollInterval = opts.pollInterval > 0 ? opts.pollInterval : 2000;
        let deadline     = Date.now() + timeout;
        let observed     = null;
        let lastError    = null;

        for (;;) {
            try {
                let attempt = await readOnce();
                if (attempt && attempt.satisfied) return attempt.result;
                if (attempt && attempt.observed !== undefined) observed = attempt.observed;
                lastError = null;
            } catch (e) {
                lastError = e;
            }
            let remaining = deadline - Date.now();
            if (remaining <= 0) throw timeoutError(observed, lastError);
            await new Promise(r => setTimeout(r, Math.min(pollInterval, remaining)));
        }
    }

    // Wait until a contract's own state satisfies the requested condition.
    // opts:
    //   key          - state key to read (reads the whole state map when absent)
    //   equals       - parsed value that the keyed state must hold
    //   match        - predicate(state, ctx) used as the condition
    //   timeout      - ms before rejecting (default 120000)
    //   pollInterval - ms between reads (default 2000)
    //   explorer options - the same target override accepted by waitForTxid
    // A key without equals or match gates on key existence. The timeout error
    // carries the last observed state for diagnosis.
    async waitForContractState(contractActionIndex, opts = {}) {
        contractWait.validateStateArgs(contractActionIndex, opts);

        let explorer = this.resolveExplorer(opts);
        let key      = opts.key;

        return this.pollUntil(opts, async () => {
            let raw   = await explorer.getContractState(contractActionIndex, key);
            return contractWait.classifyState(ActionWaiter, raw, key, opts,
                contractActionIndex, sameStateValue);
        }, (observed, lastError) => new SDKActionError('CONTRACT_STATE_TIMEOUT',
            'Contract ' + contractActionIndex + ' state' + (key !== undefined ? ' key ' + key : '') +
            ' did not reach the expected value within ' + (opts.timeout > 0 ? opts.timeout : 120000) + 'ms. ' +
            'The action may be indexed but not yet executed against the contract; settling now would ' +
            'spend inputs the pending action already used.',
            { contractActionIndex, key, expected: opts.equals, state: observed,
              timeout: opts.timeout, cause: lastError || undefined }));
    }

    // Wait until a contract holds tokens, including deposits with no state write.
    // opts adds minQuantity (default: any quantity above zero) and the same
    // match/timeout/pollInterval/explorer options as waitForContractState.
    // match(quantity, ctx) receives an exact decimal string.
    async waitForContractBalance(contractActionIndex, tick, opts = {}) {
        contractWait.validateBalanceArgs(contractActionIndex, tick);

        let explorer = this.resolveExplorer(opts);
        let minimum  = contractWait.minimumQuantity(opts);

        return this.pollUntil(opts, async () => {
            let raw      = await explorer.getContractBalance(contractActionIndex, tick);
            return contractWait.classifyBalance(ActionWaiter, raw, tick, opts,
                contractActionIndex, minimum, compareAmount);
        }, (observed, lastError) => contractWait.balanceTimeoutError(
            contractActionIndex, tick, opts, minimum, observed, lastError));
    }

    // Unpack rows from an explorer envelope or bare array.
    static rowsOf(raw) {
        return contractValues.rowsOf(raw);
    }

    // Parse explorer JSON text into the value seen by the VM.
    static parseStateValue(value) {
        return contractValues.parseStateValue(value);
    }

    // Normalize explorer state shapes into a null-prototype value map.
    static normalizeContractState(raw) {
        return contractValues.normalizeContractState(ActionWaiter, raw);
    }

    // Read one state key while preserving the distinction between absent and null.
    static readContractStateValue(raw, key) {
        return contractValues.readContractStateValue(ActionWaiter, raw, key);
    }

    // Read one tick balance as an exact decimal string, or null when absent.
    static readContractQuantity(raw, tick) {
        return contractValues.readContractQuantity(ActionWaiter, raw, tick);
    }

}

// Equality against a caller's expected state value. The parsed value may be a
// string, a number, a boolean or a structure, and a caller writing
// equals: 'FUNDED' should match whichever of those the contract stored, so
// scalars compare by their string form and structures by canonical JSON.
function sameStateValue(value, expected) {
    if (value === undefined || value === null) return value === expected;
    if (typeof value === 'object' || typeof expected === 'object') {
        try { return JSON.stringify(value) === JSON.stringify(expected); }
        catch (e) { return false; }
    }
    return String(value) === String(expected);
}

// Decimal comparison for token quantities, which routinely exceed what a
// double represents exactly. Returns -1 / 0 / 1, and -1 for a value that will
// not parse, so a malformed read reads as NOT enough rather than settling a
// gate the chain has not satisfied.
//
// Compares with the bignumber's own cmp, NOT mathjs.smaller/larger: those apply
// a relative tolerance (config.relTol, 1e-12 by default), under which two
// quantities one unit apart above 2^53 compare EQUAL - exactly the pair a
// balance gate has to tell apart.
function compareAmount(a, b) {
    return contractValues.compareAmount(a, b);
}

module.exports = ActionWaiter;
