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
 * XChain Platform SDK - pre-flight engine entry point (spec §4)
 *
 * sdk.preflight(actionData, opts): predict whether the indexer would
 * reject an action BEFORE anything is signed. Two tiers run
 * concurrently: Tier 1 (authoritative server dry-run) and Tier 2
 * (certified client matrix). Tier 1's real verdict is authoritative
 * (contradicting Tier-2 errors downgrade to info); Tier-2 errors
 * stand alone only when Tier 1 produced no verdict.
 *
 * Modes: 'enforce' (default; verdict 'fail' throws SDKPreflightError),
 * 'report' (never throws; the wallet's mode), 'local' (Tier-2 local
 * checks only, zero network), false (skip).
 *
 * Unparseable raw input THROWS SDKFormatError - a distinct, documented
 * class from SDKPreflightError, so callers tell "bad input" from
 * "would be rejected".
 *
 ********************************************************************/

'use strict';

const { parse } = require('../decoder/parse.js');
const Utility = require('../utility.js');
const { SDKFormatError, SDKPreflightError } = require('../errors.js');
const { REPORT_SCHEMA_VERSION, DEFAULT_TIMEOUT_MS, FINDING_CODES } = require('./constants.js');
const { CheckContext } = require('./context.js');
const { runUniversal } = require('./universal.js');
const { runActionChecks } = require('./checks/index.js');
const { runTier1 } = require('./tier1.js');
const { Coalescer } = require('./lifecycle.js');

// Virtual actions have no user-encodable wire FORMAT (they are settled
// on-chain by other means) but the wallet still needs a pre-flight for
// them. DISPENSE (buying from a dispenser: the user sends native coin,
// there is no DISPENSE action string) is the v3-added row. Params map
// positionally after VERSION for the string form.
const VIRTUAL_ACTION_FIELDS = {
    DISPENSE: ['DISPENSER_ACTION_INDEX', 'UNITS'],
};

function buildVirtual(action, fields) {
    return {
        ok: true, action, version: 0, params: { ...fields }, rest: null,
        commands: null,
        actionString: action + '|0|' + (fields.DISPENSER_ACTION_INDEX || ''),
        validation: { ok: true, findings: [] },
    };
}

// The compose core used to turn { action, params } into a wire string. Callers
// inside the SDK hand in `sdk.actions`; the exported form is also called with
// one argument, so fall back to a bare {config, util} shim, which is the shape
// the Actions constructor already documents as supported.
let _fallbackActions = null;
function defaultActions() {
    if (!_fallbackActions) {
        const Actions = require('../actions.js');
        _fallbackActions = new Actions({ config: {}, util: new Utility() });
    }
    return _fallbackActions;
}

// Normalize the accepted input forms into a ParsedAction. A raw string
// that fails to parse throws SDKFormatError (documented distinct class).
function normalizeInput(actionData, actionsCore) {
    const actions = actionsCore || defaultActions();
    if (typeof actionData === 'string' || Buffer.isBuffer(actionData)) {
        const s = String(actionData);
        const head = s.split('|')[0];
        if (VIRTUAL_ACTION_FIELDS[head]) {
            const segs = s.split('|').slice(2); // drop ACTION|VERSION
            const fields = {};
            VIRTUAL_ACTION_FIELDS[head].forEach((name, i) => { if (segs[i] !== undefined) fields[name] = segs[i]; });
            return buildVirtual(head, fields);
        }
        const parsed = parse(actionData);
        if (!parsed.ok)
            throw new SDKFormatError(parsed.code,
                'Pre-flight input could not be parsed: ' + parsed.code,
                { detail: parsed.detail });
        return parsed;
    }
    if (actionData && actionData.ok === true && actionData.action)
        return actionData; // already a ParsedAction
    if (actionData && actionData.action && VIRTUAL_ACTION_FIELDS[String(actionData.action).toUpperCase()])
        return buildVirtual(String(actionData.action).toUpperCase(), normalizeParamKeys(actionData));
    if (actionData && actionData.action) {
        // { action, params } / createAction result: build the wire string with
        // the SAME core createAction uses, then parse it, so every downstream
        // check reads one shape.
        //
        // This path used to re-implement that core, and forgot a behaviour
        // every time one was added over there: first camelCase -> UPPER_SNAKE
        // normalization, then params-level VERSION lifting (which left a bogus
        // VERSION field and made an owner's ISSUE EDIT un-pre-flightable), with
        // LEGS normalization, LIST rest-fields, DEPLOY base64 and numeric
        // casting all still missing when this was unified. `validate: false`
        // is the one deliberate difference: pre-flight REPORTS bad fields as
        // findings instead of throwing, so a headless caller still gets a
        // verdict (spec §4.2).
        try {
            const composed = actions.composeActionString(actionData, { validate: false });
            const parsed = parse(composed.actionString);
            if (parsed.ok) return parsed;
        } catch (e) { /* fall through to the throw below */ }
        throw new SDKFormatError('UNENCODABLE_INPUT',
            'Pre-flight could not derive an action string from the supplied object', { action: actionData.action });
    }
    throw new SDKFormatError('EMPTY', 'Pre-flight requires an action string or {action, params}');
}

/**
 * Field names, the way createAction takes them.
 *
 * This path re-implements the {action, params} -> action-string mapping
 * without createAction's camelCase -> UPPER_SNAKE normalization, so the
 * SAME object that composes fine ({action:'SEND', params:{tick, amount,
 * destination}}) threw UNENCODABLE_INPUT out of pre-flight. §4.2 documents
 * that exact shape as valid input, and a headless consumer under the
 * default 'enforce' mode got an exception where it expected a verdict.
 * Found the first time the §8.2 harness was actually run against a chain.
 *
 * Delegates to the same Utility.normalizeFields createAction uses rather
 * than mapping keys again: two copies of a naming convention is how they
 * drift apart in the first place. Already-UPPER_SNAKE keys pass through
 * unchanged, so callers using the canonical shape are unaffected.
 */
function normalizeParamKeys(actionData) {
    const raw = actionData.params || actionData.fields || {};
    return new Utility().normalizeFields(raw);
}

function resolveMode(optMode, sdkDefault) {
    if (optMode === false) return false;
    if (optMode === 'enforce' || optMode === 'report' || optMode === 'local') return optMode;
    if (optMode === true) return 'enforce';
    if (optMode !== undefined) return 'enforce';
    // No per-call override: fall back to the SDK default, preserving a
    // false default (a plain `|| 'enforce'` would resurrect it to enforce).
    if (sdkDefault === undefined) return 'enforce';
    return sdkDefault;
}

// Compute the report verdict from the assembled findings.
function computeVerdict(findings) {
    let hasError = false, hasWarning = false;
    for (const f of findings) {
        if (f.severity === 'error') hasError = true;
        else if (f.severity === 'warning') hasWarning = true;
    }
    return hasError ? 'fail' : hasWarning ? 'warn' : 'pass';
}

/*
 * Apply Tier-1 precedence to the assembled Tier-2 findings.
 *   - Tier-1 valid: authoritative pass. Contradicting Tier-2 ERRORS
 *     downgrade to info (kept for diagnostics). Warnings stay.
 *   - Tier-1 invalid: authoritative fail. Add the DRYRUN_INVALID error.
 *   - no verdict: Tier-2 stands on PRECEDENCE, and the absence of a
 *     network verdict is disclosed (DRYRUN_UNAVAILABLE), so a report
 *     the network declined to judge is never presented as one it passed.
 *
 * §4.7 EXCEPTION. Tier-1 is authoritative about CONFIRMED chain
 * state only. A finding computed from `localDeltas` - the caller's own
 * reservations and unconfirmed committed spends - describes state the
 * dry-run cannot see by construction: two approval windows spending the
 * same balance both dry-run valid, because on-chain each is affordable.
 * Flattening those to info made the whole reservation ledger inert in the
 * verdict (the wallet showed "Looks good" on the second window of a live
 * double-spend), so they degrade to WARNING instead: the network's pass
 * still outranks a hard client error, but the user is not told the
 * payment is clean when their own wallet has already committed the funds.
 */
/*
 * Split the arbiter's per-sub-command verdicts (BATCH only) into the three
 * outcomes they actually carry, which is NOT a two-way valid/invalid split:
 *
 *   valid    - `status === 'valid'`. The network really ran this command.
 *   invalid  - any other non-empty status string. The network ran it and
 *              rejected it.
 *   unjudged - `status === null`, with or without a `refused` note. Two live
 *              causes, both measured on BTC regtest 2026-08-13: a VM sub-action
 *              the probe refuses to dispatch (`refused` set), and a settlement
 *              leg that returns without recording a status because the probe
 *              carries no real transaction (`COINPAY|0|<match>` inside a batch
 *              answers `{status:null, refused:null}`).
 *
 * DECLARED LIMITATION, in the idiom batchLimits.js uses for its MINT-distinctness
 * approximation rather than left to be rediscovered: the SDK cannot turn a
 * settlement sub-command's `null` into a verdict, and neither can the endpoint.
 * A COINPAY obligation settles against the transaction OUTPUT paying its payee,
 * and neither public probe surface accepts an output set - `preflight` takes
 * {action, params, source, feeMode} and `feequote` adds only a scalar
 * `feeOutputSats`, so the synthetic transaction's outputs hold nothing but the
 * probe's own injected fee output. The arbiter therefore resolves no payee output
 * and returns before recording a status. Only the API-key-gated, regtest-only
 * `feequotedryrun` RPC accepts caller-supplied outputs, and it is not proxied by
 * the explorer at all. Letting a public caller DECLARE an output set is a
 * security decision (attacker-shaped outputs is one of the two named reasons that
 * RPC stays gated) and is NOT taken here. The consequence is stated honestly to
 * the caller instead: DRYRUN_SUBCOMMAND_UNJUDGED, which is why silence must never
 * be read as either verdict.
 *
 * The third bucket is the load-bearing one. Folding it into "invalid" would
 * manufacture a client-side false NEGATIVE for exactly the multi-payee COINPAY
 * case the indexer half of this work fixed - the probe cannot see the settlement
 * outputs, so it cannot judge the command, and saying "this will fail" about a
 * transaction the chain accepts is the failure mode this whole severity model
 * exists to prevent. Folding it into "valid" is worse: it would let the network's
 * silence override a Tier-2 error.
 */
function classifySubCommands(subs) {
    const valid = new Set();
    const invalid = [];
    const unjudged = [];
    for (const s of subs) {
        if (s.status === 'valid') valid.add(s.position);
        else if (typeof s.status === 'string' && s.status !== '') invalid.push(s);
        else unjudged.push(s);
    }
    return { valid, invalid, unjudged, allValid: invalid.length === 0 && unjudged.length === 0 };
}

// Turn those buckets into findings. Invalid sub-commands are ERRORS (overridable,
// like every network-sourced verdict) because the alternative is a report that
// says "pass" for a batch the network has already told us will not do what it says.
// Unjudged ones are disclosures, never errors, for the reason above.
function pushSubCommandFindings(findings, subs) {
    const cls = classifySubCommands(subs);
    for (const s of cls.invalid)
        findings.push({ code: FINDING_CODES.DRYRUN_SUBCOMMAND_INVALID, severity: 'error',
            source: 'dryrun', overridable: true,
            message: `The network reports batch command ${s.position + 1}`
                + (s.action ? ` (${s.action})` : '') + ` will fail: ${s.status}.`
                + ' A batch is not atomic, so the other commands still apply.',
            data: { commandIndex: s.position, action: s.action, status: s.status } });
    for (const s of cls.unjudged)
        findings.push({ code: FINDING_CODES.DRYRUN_SUBCOMMAND_UNJUDGED, severity: 'info',
            source: 'dryrun',
            message: `The network did not judge batch command ${s.position + 1}`
                + (s.action ? ` (${s.action})` : '') + ' ('
                + (s.refused || 'the read-only pre-flight cannot evaluate this command')
                + '); relying on client checks for it.',
            data: { commandIndex: s.position, action: s.action, refused: s.refused } });
    return cls;
}

function applyTier1(findings, tier1) {
    if (!tier1) return findings;
    if (tier1.kind === 'verdict' && tier1.valid === true) {
        // A batch answers at two levels and the outer one is not a verdict on the
        // inner ones (indexer actions/batch.js restores the BATCH's own status
        // after the dispatch loop). Report both, and say which is which.
        const cls = tier1.subCommands ? pushSubCommandFindings(findings, tier1.subCommands) : null;
        findings.push({ code: FINDING_CODES.DRYRUN_VALID, severity: 'info', source: 'dryrun',
            message: cls
                ? (cls.allValid
                    ? `The network dry-run accepted this batch and all ${tier1.subCommands.length} of its commands.`
                    : 'The network dry-run accepted this batch transaction, but NOT every command in it'
                      + ` (${cls.valid.size} of ${tier1.subCommands.length} accepted); see the per-command findings.`)
                : 'The network dry-run accepted this action.',
            data: cls ? { subCommandCount: tier1.subCommands.length, accepted: cls.valid.size } : {} });
        if (tier1.oracleFeesOwed)
            findings.push({ code: FINDING_CODES.DRYRUN_ORACLE_FEES_OWED, severity: 'info',
                source: 'dryrun',
                message: 'This batch owes oracle usage fees the pre-flight discloses rather than checks: '
                    + Object.entries(tier1.oracleFeesOwed).map(([a, v]) => `${v} to ${a}`).join(', ')
                    + '. Size those outputs yourself; the dry-run has no outputs to check them against.',
                data: { oracleFeesOwed: tier1.oracleFeesOwed } });
        for (const f of findings) {
            if (f.severity === 'error' && f.source === 'client') {
                // §4.7 + per-sub-command precedence. Tier 1 outranks a Tier-2 error
                // only where it actually judged the thing the error is about. For a
                // batch that is PER COMMAND: a finding tagged with a commandIndex is
                // outranked only if the network accepted THAT command, and an
                // untagged (batch-level) finding only if it accepted every command.
                // Without this the outer valid:true would silently flatten the whole
                // Tier-2 batch projection - measured shape: a batch whose only
                // command is an unknown-tick SEND answers valid:true, so the SDK's
                // own TOKEN_NOT_FOUND error would have been demoted to info and the
                // report rendered as a clean network approval.
                if (cls) {
                    const ci = f.data ? f.data.commandIndex : undefined;
                    const outranked = Number.isInteger(ci) ? cls.valid.has(ci) : cls.allValid;
                    if (!outranked) continue;
                }
                const localOnly = !!(f.data && f.data.localDeltaApplied);
                f.severity = localOnly ? 'warning' : 'info';
                f._downgradedBy = localOnly ? 'dryrun-valid-local-delta' : 'dryrun-valid';
                if (localOnly) delete f.overridable;   // warnings carry no override flag (§4.2)
            }
        }
    } else if (tier1.kind === 'verdict' && tier1.valid === false) {
        // An invalid batch header runs no sub-commands, so there is normally nothing
        // here; reported anyway rather than dropped, because a response that carries
        // both is telling the caller something and silently discarding half of it is
        // how the outer-level-only reading got wrong in the first place.
        if (tier1.subCommands) pushSubCommandFindings(findings, tier1.subCommands);
        findings.push({ code: FINDING_CODES.DRYRUN_INVALID, severity: 'error', source: 'dryrun',
            overridable: true,
            message: 'The network reports this will fail: ' + (tier1.status || tier1.error || 'rejected'),
            data: { status: tier1.status, error: tier1.error } });
    } else if (tier1.kind === 'unavailable') {
        findings.push({ code: FINDING_CODES.DRYRUN_UNAVAILABLE, severity: 'info', source: 'dryrun',
            message: 'The network dry-run was unavailable (' + tier1.reason + '); relying on client checks.', data: {} });
    } else if (tier1.kind === 'no-verdict') {
        // The network answered and DECLINED to judge: a controller-bound action
        // whose guard the public dry-run refuses to enter (guardInert), a
        // denylisted VM action, a fee-exempt reply that never ran the handler,
        // or an unquotable one. "Tier-2 stands" is right about PRECEDENCE and
        // was wrong about DISCLOSURE - pushing no finding at all left the report
        // a clean pass, so a client rendered it identically to a network
        // approval. That is the same regression in its second home: measured
        // on a controller-bound token's SEND, whose confirm screen read "Looks
        // good" on a transfer the chain then refused `controller (reverted)`.
        // Same code as the unreachable case on purpose: every client already
        // routes DRYRUN_UNAVAILABLE to its "not an approval" presentation, and a
        // new code would leave each of them showing the old, wrong screen until
        // it learned about it.
        //
        // 'local-only mode' arrives here too, and it is a different sentence:
        // nothing declined anything, the caller asked for no network check. Both
        // still owe the same disclosure, so they share the code and differ in
        // the words - a message that called a deliberate opt-out a refusal would
        // be the mirror of the bug being fixed.
        const declined = tier1.reason !== 'local-only mode';
        findings.push({ code: FINDING_CODES.DRYRUN_UNAVAILABLE, severity: 'info', source: 'dryrun',
            message: (declined
                ? 'The network declined to judge this action ('
                : 'The network was not consulted (')
                + tier1.reason + '); relying on client checks.',
            // When a batch was refused over ONE of its sub-actions, the name is
            // the actionable half of the answer, so it rides in `data` and not
            // only in the prose: a confirm screen can point at the offending
            // command, which a message string does not let it do.
            data: tier1.deniedSubAction ? { deniedSubAction: tier1.deniedSubAction } : {} });
    }
    return findings;
}

// Bound the elapsed clock without a bare Date.now sprinkled everywhere.
function nowMs() { return Date.now(); }

async function runPreflight(sdk, actionData, opts = {}) {
    const mode = resolveMode(opts.preflight, sdk._preflightMode);
    if (mode === false) return null;

    const started = nowMs();
    const parsed = normalizeInput(actionData, sdk.actions);

    const chain = opts.chain || opts.chainId || (sdk.config && sdk.config.network) || null;
    const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

    const producer = async () => {
        const ctx = new CheckContext({
            sdk, parsed, source: opts.source, mode,
            signal: opts.signal, timeoutMs, localDeltas: opts.localDeltas,
            feeMode: opts.feeMode,
        });

        // Tier 1 (skipped entirely in 'local' mode) and Tier 2 run
        // concurrently against the shared timeout budget.
        const tier1Promise = mode === 'local'
            ? Promise.resolve({ kind: 'no-verdict', reason: 'local-only mode' })
            // `feeMode` rides through to the network dry run: the verdict differs
            // between paying the protocol fee from an XCHAIN balance and paying it
            // as a coin output, and a caller that has already chosen must not be
            // judged against the chain default (see runTier1).
            : runTier1({ sdk, parsed, source: opts.source, feeMode: opts.feeMode,
                signal: opts.signal, timeoutMs })
                .catch(e => ({ kind: 'unavailable', reason: e && e.message ? e.message : String(e) }));

        const tier2Promise = (async () => {
            await runUniversal(ctx, { encoding: opts.encoding });
            await runActionChecks(ctx);
        })();

        const [tier1] = await Promise.all([tier1Promise, tier2Promise]);

        const findings = applyTier1(ctx.findings, tier1);
        const verdict = computeVerdict(findings);
        const quote = (tier1 && tier1.quote) || null;
        const stateHeight = (tier1 && typeof tier1.blockIndex === 'number') ? tier1.blockIndex : null;

        const report = {
            schemaVersion: REPORT_SCHEMA_VERSION,
            verdict,
            restricted: false,
            checksRun: Array.from(ctx.checksRun),
            findings,
            unverified: ctx.unverified,
            quote,
            stateHeight,
            elapsedMs: nowMs() - started,
            _stampedAt: nowMs(),
        };
        return report;
    };

    const report = await sdk._preflightCoalescer.run({
        chainId: chain, actionString: parsed.actionString, source: opts.source,
        localDeltas: opts.localDeltas,
        signal: opts.signal, bypass: opts.bypassCache === true,
    }, producer);

    if (mode === 'enforce' && report.verdict === 'fail') {
        throw new SDKPreflightError(
            'Pre-flight rejected this action: ' + summarizeErrors(report.findings), report);
    }
    return report;
}

function summarizeErrors(findings) {
    const errs = findings.filter(f => f.severity === 'error').map(f => f.code);
    return errs.length ? errs.join(', ') : 'unknown';
}

/*
 * Bind pre-flight onto an SDK instance. Called from the XChainSDK
 * constructor. Stores the resolved default mode as `_preflightMode`
 * and exposes the callable `sdk.preflight(actionData, opts)`.
 */
function attach(sdk, option) {
    sdk._preflightMode = resolveMode(option, 'enforce');
    sdk._preflightCoalescer = new Coalescer();
    sdk.preflight = (actionData, opts) => runPreflight(sdk, actionData, opts);
    sdk.preflight.mode = sdk._preflightMode;
}

module.exports = { attach, runPreflight, normalizeInput, resolveMode, computeVerdict, applyTier1 };
