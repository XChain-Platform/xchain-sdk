/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
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
 * XChain Platform SDK - pre-flight Tier 1 (server-side dry-run)
 *
 * Wraps the explorer dry-run endpoint (indexer -> _dryRunAction: the
 * REAL handler in a forced-rollback transaction) and classifies its
 * response per spec §4.3. Prefers the  validity-first
 * `/preflight` endpoint (verdict decoupled from native-fee support,
 * guardInert surfaced as a boolean); falls back to `/feequote` when
 * the explorer predates  (404). The load-bearing rule: several
 * response shapes are NOT validity verdicts and must fall through to
 * Tier 2 exclusively, never becoming a `dryrun` finding:
 *
 *   1. supported:false      (unquotable / no FEE_DESTINATION on the
 *                            legacy feequote path; the /preflight path
 *                            decouples this)
 *   2. feeExempt:true       (FEE_QUOTE_EXEMPT: COINPAY, DISPENSE,
 *                            settlement legs - the handler NEVER RAN;
 *                            treating this as a pass would show a
 *                            false PASS on e.g. a nonexistent COINPAY
 *                            obligation)
 *   3. denylisted VM actions (DEPLOY/EXECUTE/XEXEC/BATCH; the
 *                            /preflight path marks these denied:true)
 *   4. guardInert            (controller guard outcome not truthful
 *                            on the public path)
 *   5. timeout / queue-full  -> DRYRUN_UNAVAILABLE
 *
 ********************************************************************/

'use strict';

const { FINDING_CODES, TIER1_DENYLIST } = require('./constants.js');

/*
 * Run Tier 1 for a parsed action.
 *
 * @returns {object} outcome
 *   { kind: 'verdict', valid, status, error, quote, blockIndex }
 *   { kind: 'no-verdict', reason }   // fell through to Tier 2 only
 *   { kind: 'unavailable', reason }  // DRYRUN_UNAVAILABLE + Tier 2
 */
async function runTier1({ sdk, parsed, source, signal, timeoutMs }) {
    const action = parsed.action;

    if (TIER1_DENYLIST.includes(action))
        return { kind: 'no-verdict', reason: 'denylisted' };

    if (!sdk.explorer)
        return { kind: 'unavailable', reason: 'no explorer client' };

    let quote;
    try {
        quote = await withAbort(callEndpoint(sdk, {
            action,
            params: paramsToWire(parsed),
            source,
        }), signal, timeoutMs);
    } catch (e) {
        return { kind: 'unavailable', reason: e && e.message ? e.message : String(e) };
    }

    if (!quote || typeof quote !== 'object')
        return { kind: 'unavailable', reason: 'malformed dry-run response' };

    // Busy / admission-capped responses surface retryable markers.
    if (quote.busy === true || quote.retryable === true)
        return { kind: 'unavailable', reason: 'dry-run queue full' };

    // Rule 3: /preflight marks denylisted VM actions explicitly.
    if (quote.denied === true)
        return { kind: 'no-verdict', reason: 'denylisted', quote };

    // Rule 2: feeExempt responses claim supported/valid WITHOUT running
    // the handler; they carry fee/lifecycle info only.
    if (quote.feeExempt === true)
        return { kind: 'no-verdict', reason: 'feeExempt', quote };

    // Rule 4: guard-inert / controller-unsupported responses (the
    // /preflight path sets the boolean; feequote uses the string sentinel).
    if (quote.guardInert === true ||
        String(quote.error || '').includes('FEE_QUOTE_CONTROLLER_UNSUPPORTED'))
        return { kind: 'no-verdict', reason: 'guardInert', quote };

    // Rule 1: unquotable is not a verdict. On the /preflight path
    // supported:false only appears for denied/exempt (handled above), so
    // this is the legacy-feequote no-FEE_DESTINATION case.
    if (quote.supported === false)
        return { kind: 'no-verdict', reason: 'unsupported', quote };

    if (typeof quote.valid !== 'boolean')
        return { kind: 'unavailable', reason: 'no verdict field in response' };

    return {
        kind: 'verdict',
        valid: quote.valid,
        status: quote.status || null,
        error: quote.error || null,
        quote,
        blockIndex: quote.blockIndex !== undefined ? quote.blockIndex : null,
    };
}

// Prefer the  validity-first /preflight endpoint; fall back to
// /feequote when the explorer predates it (404) or lacks the method.
// The classification above handles both response shapes uniformly.
async function callEndpoint(sdk, args) {
    if (typeof sdk.explorer.getPreflight === 'function') {
        try {
            return await sdk.explorer.getPreflight(args, { noRetry: true });
        } catch (e) {
            const notFound = e && (e.code === 'EXPLORER_HTTP_404' || e.code === 'EXPLORER_HTTP_501');
            if (!notFound) throw e;
            // fall through to the legacy fee-quote endpoint
        }
    }
    return sdk.explorer.getFeeQuote(args);
}

// The wire params string for the quote endpoint: everything after
// ACTION| in the canonical string (VERSION|F1|F2|...).
function paramsToWire(parsed) {
    const s = parsed.actionString;
    const idx = s.indexOf('|');
    return idx === -1 ? '' : s.slice(idx + 1);
}

// Abort/timeout race: the underlying HTTP call may continue, but a
// timed-out or aborted check must never land in the report later.
function withAbort(promise, signal, timeoutMs) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = timeoutMs ? setTimeout(() => {
            if (!settled) { settled = true; reject(new Error('tier1 timeout after ' + timeoutMs + 'ms')); }
        }, timeoutMs) : null;
        const onAbort = () => {
            if (!settled) { settled = true; if (timer) clearTimeout(timer); reject(new Error('aborted')); }
        };
        if (signal) {
            if (signal.aborted) return onAbort();
            signal.addEventListener('abort', onAbort, { once: true });
        }
        promise.then(
            v => { if (!settled) { settled = true; if (timer) clearTimeout(timer); resolve(v); } },
            e => { if (!settled) { settled = true; if (timer) clearTimeout(timer); reject(e); } },
        );
    });
}

module.exports = { runTier1, withAbort, paramsToWire, callEndpoint, FINDING_CODES };
