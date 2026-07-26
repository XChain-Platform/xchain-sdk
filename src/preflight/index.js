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

// Normalize the accepted input forms into a ParsedAction. A raw string
// that fails to parse throws SDKFormatError (documented distinct class).
function normalizeInput(actionData) {
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
        // { action, params } / createAction result: re-serialize through
        // the canonical parser so every downstream check reads one shape.
        const FormatSelector = require('../formatSelector.js');
        const fields = normalizeParamKeys(actionData);
        // createAction lets a caller FORCE a format version by putting
        // `version` in params (STAKE v1 vs v2, ISSUE create vs edit), lifting
        // it out and deleting it before serializing. Pre-flight only read a
        // top-level `version`, so a params-level one stayed behind as a bogus
        // VERSION field and broke select/serialize - an owner's ISSUE EDIT
        // could not be pre-flighted at all. Same root cause as the camelCase
        // gap above: this path re-implements createAction instead of reusing
        // it, so every behaviour it forgets is a silent hole. Keep the two in
        // lockstep until they can share one implementation.
        let version = actionData.version;
        if (fields.VERSION !== undefined && fields.VERSION !== null && fields.VERSION !== '') {
            if (version === undefined || version === null) version = fields.VERSION;
            delete fields.VERSION;
        }
        try {
            const sel = FormatSelector.select(String(actionData.action).toUpperCase(), fields, version);
            const str = FormatSelector.serialize(String(actionData.action).toUpperCase(), sel.version, fields);
            const parsed = parse(str);
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
 *  re-implemented the {action, params} -> action-string path here
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
 *   - no verdict: Tier-2 stands.
 */
function applyTier1(findings, tier1) {
    if (!tier1) return findings;
    if (tier1.kind === 'verdict' && tier1.valid === true) {
        findings.push({ code: FINDING_CODES.DRYRUN_VALID, severity: 'info', source: 'dryrun',
            message: 'The network dry-run accepted this action.', data: {} });
        for (const f of findings) {
            if (f.severity === 'error' && f.source === 'client') {
                f.severity = 'info';
                f._downgradedBy = 'dryrun-valid';
            }
        }
    } else if (tier1.kind === 'verdict' && tier1.valid === false) {
        findings.push({ code: FINDING_CODES.DRYRUN_INVALID, severity: 'error', source: 'dryrun',
            overridable: true,
            message: 'The network reports this will fail: ' + (tier1.status || tier1.error || 'rejected'),
            data: { status: tier1.status, error: tier1.error } });
    } else if (tier1.kind === 'unavailable') {
        findings.push({ code: FINDING_CODES.DRYRUN_UNAVAILABLE, severity: 'info', source: 'dryrun',
            message: 'The network dry-run was unavailable (' + tier1.reason + '); relying on client checks.', data: {} });
    }
    return findings;
}

// Bound the elapsed clock without a bare Date.now sprinkled everywhere.
function nowMs() { return Date.now(); }

async function runPreflight(sdk, actionData, opts = {}) {
    const mode = resolveMode(opts.preflight, sdk._preflightMode);
    if (mode === false) return null;

    const started = nowMs();
    const parsed = normalizeInput(actionData);

    const chain = opts.chain || opts.chainId || (sdk.config && sdk.config.network) || null;
    const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

    const producer = async () => {
        const ctx = new CheckContext({
            sdk, parsed, source: opts.source, mode,
            signal: opts.signal, timeoutMs, localDeltas: opts.localDeltas,
        });

        // Tier 1 (skipped entirely in 'local' mode) and Tier 2 run
        // concurrently against the shared timeout budget.
        const tier1Promise = mode === 'local'
            ? Promise.resolve({ kind: 'no-verdict', reason: 'local-only mode' })
            : runTier1({ sdk, parsed, source: opts.source, signal: opts.signal, timeoutMs })
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
