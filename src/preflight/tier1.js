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
 * response per spec §4.3. Prefers the validity-first
 * `/preflight` endpoint (verdict decoupled from native-fee support,
 * guardInert surfaced as a boolean); falls back to `/feequote` when
 * the explorer predates the `/preflight` endpoint (404). The load-bearing rule: several
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
 *   3. denylisted VM actions (DEPLOY/EXECUTE/XEXEC; the
 *                            /preflight path marks these denied:true).
 *                            XEXEC is defence-in-depth only: it is
 *                            arbiter-emitted, has no wire format, and so
 *                            never arrives here from decoder.parse. See the
 *                            TIER1_DENYLIST comment in constants.js for why
 *                            the unreachable entry stays.
 *                            BATCH is the ONE denylisted action /preflight now
 *                            answers, per sub-command, so it is sent to the
 *                            endpoint (TIER1_SUBCOMMAND_PREFLIGHT) - and the
 *                            SAME rule 3 still catches it when the arbiter
 *                            refuses one of its sub-commands, which it reports
 *                            as denied:true + deniedSubAction.
 *   4. guardInert            (controller guard outcome not truthful
 *                            on the public path)
 *   5. timeout / queue-full  -> DRYRUN_UNAVAILABLE
 *
 ********************************************************************/

'use strict';

const { FINDING_CODES, TIER1_DENYLIST, TIER1_SUBCOMMAND_PREFLIGHT } = require('./constants.js');

/*
 * Run Tier 1 for a parsed action.
 *
 * `feeMode` ('xchain' | 'native', optional) states how the transaction being
 * composed will settle the protocol fee. It MATTERS, and omitting it was a real
 * defect: /preflight answers for the chain's DEFAULT mode when it is absent, so
 * a Bitcoin action whose author opted into paying the fee in coin was judged
 * against their XCHAIN balance - and a payer with no XCHAIN (exactly the user
 * the native lane exists for) was told "invalid: insufficient funds (FEE)" for
 * an action the same endpoint calls valid when asked in the right mode.
 * Measured on regtest before this was threaded through. Omit it to keep the
 * chain default (native on LTC/DOGE, the XCHAIN debit on BTC).
 *
 * @returns {object} outcome
 *   { kind: 'verdict', valid, status, error, quote, blockIndex }
 *   { kind: 'no-verdict', reason }   // fell through to Tier 2 only
 *   { kind: 'unavailable', reason }  // DRYRUN_UNAVAILABLE + Tier 2
 */
async function runTier1({ sdk, parsed, source, feeMode, signal, timeoutMs }) {
    const action = parsed.action;

    // Denylisted actions short-circuit WITHOUT a network call, except the one the
    // arbiter's /preflight answers per sub-command. Deleting the second clause is
    // what re-hides a batch's verdict; deleting the first hands DEPLOY/EXECUTE/XEXEC
    // to an unauthenticated endpoint that would refuse them anyway, at the cost of a
    // round trip and a mutex acquisition.
    const subCommandPreflight = TIER1_SUBCOMMAND_PREFLIGHT.includes(action);
    if (TIER1_DENYLIST.includes(action) && !subCommandPreflight)
        return { kind: 'no-verdict', reason: 'denylisted' };

    if (!sdk.explorer)
        return { kind: 'unavailable', reason: 'no explorer client' };

    let quote;
    try {
        quote = await withAbort(callEndpoint(sdk, {
            action,
            params: paramsToWire(parsed),
            source,
            // Passed only when the caller stated one: an undefined key would be
            // serialized into the query as the string "undefined".
            ...(feeMode ? { feeMode } : {}),
        }, subCommandPreflight), signal, timeoutMs);
    } catch (e) {
        return { kind: 'unavailable', reason: e && e.message ? e.message : String(e) };
    }

    if (!quote || typeof quote !== 'object')
        return { kind: 'unavailable', reason: 'malformed dry-run response' };

    // Busy / admission-capped responses surface retryable markers.
    if (quote.busy === true || quote.retryable === true)
        return { kind: 'unavailable', reason: 'dry-run queue full' };

    // Rule 3: /preflight marks denylisted VM actions explicitly.
    //
    // For a sub-command pre-flight the arbiter names WHICH sub-action it refused
    // (`deniedSubAction`), and that name is the whole answer a composer needs: the
    // batch is not un-pre-flightable, one command in it is. Surfacing it in the
    // reason keeps the refusal a clear answer rather than a bare "denylisted" a
    // caller cannot act on, and `deniedSubAction` is carried on the outcome so a
    // client can point at the command. Trimmed and capped because it is
    // server-supplied text landing in a user-visible message.
    if (quote.denied === true) {
        const sub = typeof quote.deniedSubAction === 'string'
            ? quote.deniedSubAction.trim().slice(0, 32) : '';
        if (sub)
            return { kind: 'no-verdict', reason: 'denylisted sub-action ' + sub,
                deniedSubAction: sub, quote };
        return { kind: 'no-verdict', reason: 'denylisted', quote };
    }

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
        // BATCH only, and the reason this outcome is not just `valid`. The outer
        // verdict answers "is this transaction accepted", the inner ones answer
        // "does each command succeed", and a batch is NOT atomic so the first
        // does not imply the second. Normalized here so applyTier1 reads one
        // shape and a malformed/absent field is simply "no sub-verdicts" rather
        // than a throw inside the report builder.
        subCommands: normalizeSubCommands(quote.subCommands),
        // Per-oracle totals the arbiter discloses instead of judging.
        oracleFeesOwed: (quote.oracleFeesOwed && typeof quote.oracleFeesOwed === 'object'
            && !Array.isArray(quote.oracleFeesOwed)) ? quote.oracleFeesOwed : null,
    };
}

/*
 * Normalize the arbiter's `subCommands` array into
 * [{ position, action, status, refused }], or null when the response carries none
 * (every non-BATCH action, and any explorer/indexer that predates the door).
 *
 * `position` falls back to the array index rather than being dropped: it is what
 * ties a network verdict to a Tier-2 finding's `commandIndex`, and the whole
 * per-command precedence rule in applyTier1 is keyed on it. The arbiter emits it
 * as its own 0-based batch position (indexer actions/batch.js `batchPosition`),
 * which is the same counter, so the fallback only ever covers a malformed row.
 */
function normalizeSubCommands(raw) {
    if (!Array.isArray(raw) || raw.length === 0) return null;
    return raw.map((entry, i) => {
        const e = (entry && typeof entry === 'object') ? entry : {};
        return {
            position: Number.isInteger(e.position) ? e.position : i,
            action: typeof e.action === 'string' ? e.action : null,
            // A settlement leg the probe could not judge returns without recording
            // a status, and the arbiter reports that as null. It is NOT a failure
            // and must never be read as one (see applyTier1).
            status: typeof e.status === 'string' ? e.status : null,
            refused: typeof e.refused === 'string' ? e.refused : null,
        };
    });
}

// Prefer the validity-first /preflight endpoint; fall back to
// /feequote when the explorer predates it (404) or lacks the method.
// The classification above handles both response shapes uniformly.
//
// `subCommandPreflight` marks an action that ONLY /preflight answers (BATCH).
// The fee-quote fallback is skipped for it on purpose rather than left to
// return the flat refusal: /feequote refuses a batch DELIBERATELY and
// permanently (its fee is the sum of state-dependent sub-fees), so calling it
// would spend a round trip to be told something already known. The
// substituted response is the same flat refusal the fallback would have
// produced, so an explorer that predates the sub-command door degrades to
// exactly the pre-row-55 behaviour: no-verdict, Tier 2 stands, disclosed.
async function callEndpoint(sdk, args, subCommandPreflight) {
    if (typeof sdk.explorer.getPreflight === 'function') {
        try {
            return await sdk.explorer.getPreflight(args, { noRetry: true });
        } catch (e) {
            const notFound = e && (e.code === 'EXPLORER_HTTP_404' || e.code === 'EXPLORER_HTTP_501');
            if (!notFound) throw e;
            // fall through to the legacy fee-quote endpoint
        }
    }
    if (subCommandPreflight)
        return { supported: false, denied: true, valid: null };
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

module.exports = { runTier1, withAbort, paramsToWire, callEndpoint, normalizeSubCommands, FINDING_CODES };
