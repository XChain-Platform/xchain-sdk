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
 * XChain Platform SDK - Agent Session
 *
 * A WalletSession with a declarative spending policy enforced at the
 * submit() chokepoint, built for handing a key to an AUTOMATED AGENT
 * with a bounded blast radius. Fail-closed throughout: no allowedActions
 * means nothing is allowed; a corrupt usage-state file blocks submits
 * rather than silently resetting the window.
 *
 *   let agent = sdk.agentSession(wif, {
 *       allowedActions: ['SEND', 'EXECUTE'],
 *       allowedDestinations: ['bc1q...'],                  // optional
 *       maxPerAction: { SEND: { MYTOKEN: '100', '*': '10' } },
 *       maxPerWindow: { hours: 24, perTick: { MYTOKEN: '500' }, maxActions: 50 },
 *       confirmAbove: { perTick: { '*': '50' }, handler: async (ctx) => bool },
 *       idempotencyHours: 720,                             // key memory, default 30d
 *       onPolicyViolation: (violation) => { ... },         // observe denials
 *       stateFile: '/path/to/usage.json'                   // window persistence
 *   });
 *   await agent.send({ tick: 'MYTOKEN', amount: '5', destination: addr });
 *
 * HONESTY NOTE: this is a client-side guardrail, not a security
 * boundary: whoever holds the WIF can bypass it with raw SDK calls.
 * The hard-enforcement upgrade is the MuSig2 co-signer (src/cosigner/),
 * which runs this same policy server-side and withholds its partial
 * signature on any out-of-policy PSBT; see MuSig2AgentSession.
 *
 ********************************************************************/

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const WalletSession    = require('../utils/wallet_session.js');
const { SDKPolicyError } = require('../utils/errors.js');
// The pure policy verdict is shared with the co-signer daemon so both
// enforcement points run identical logic. AgentSession adds the throw +
// observer + file-backed window store around it.
const { evaluatePolicy, addDecimal, hasEnforceableCap, UNRESOLVED_TICK_BUCKET } = require('./policy_evaluator.js');

function validatePolicy(policy) {
    if (!Array.isArray(policy.allowedActions) || policy.allowedActions.length === 0)
        throw new SDKPolicyError('POLICY_INVALID',
            'AgentSession requires a non-empty allowedActions list (fail-closed: nothing is allowed by default)');
    const win = policy.maxPerWindow || null;
    if (win && (!Number.isFinite(win.hours) || win.hours <= 0))
        throw new SDKPolicyError('POLICY_INVALID', 'maxPerWindow.hours must be a positive number');
    if (policy.confirmAbove && typeof policy.confirmAbove.handler !== 'function')
        throw new SDKPolicyError('POLICY_INVALID', 'confirmAbove requires a handler function');
    // How long an idempotency key is REMEMBERED, which is not how long a spend
    // window lasts (see pruned).
    if (policy.idempotencyHours !== undefined
        && (!Number.isFinite(policy.idempotencyHours) || policy.idempotencyHours <= 0))
        throw new SDKPolicyError('POLICY_INVALID', 'idempotencyHours must be a positive number');
    // Require at least one enforceable ceiling. An action allowlist controls what
    // an agent may do, not how much value it may move, so an allowlist without a
    // monetary ceiling leaves every permitted action unbounded. Running that way
    // is an explicit, auditable opt-in rather than a state reached by omission,
    // matching the X402Client fail-closed default.
    //
    // The cap tables are tested for an ENFORCEABLE entry, not for truthiness:
    // `maxPerAction: {}`, `{ SEND: {} }` and `maxPerWindow.perTick: {}` are all
    // truthy objects that capFor resolves to undefined for every lookup, so a
    // truthiness test passes each one through this gate while every amount
    // comparison in policyEvaluator is skipped - an allowlisted SEND of any size,
    // under a policy the operator reads as capped.
    const hasCeiling = hasEnforceableCap(policy.maxPerAction, { twoLevel: true })
        || hasEnforceableCap(win && win.perTick)
        || !!policy.confirmAbove;
    if (!hasCeiling && policy.allowUnbounded !== true)
        throw new SDKPolicyError('POLICY_INVALID',
            'AgentSession requires at least one spend ceiling: maxPerAction, maxPerWindow.perTick, ' +
            'or confirmAbove. An allowlist alone bounds WHICH actions run, never how much they move, ' +
            'and a cap table with no usable entry (e.g. {} or { SEND: {} }) is not a ceiling. ' +
            'Set allowUnbounded: true to run without one.');
    return win;
}
function authorizeSubmission(session, evaluation, submitOpts) {
    // Record the window entry on AUTHORIZATION, before the irreversible broadcast,
    // then patch in the real txid on success. Mirrors coSigner.recordBudget /
    // windowStore ("consume the budget on authorization"): submitInner can throw
    // AFTER the money has moved (a CONFIRMATION_TIMEOUT on the 120s indexer wait, a
    // P2SH phase-2 failure, a lost broadcast ACK), and if usage were recorded only
    // afterward that throw would leave the spend on-chain with the window un-consumed
    // and the cap silently under-counting -- exactly the case a retrying agent hits.
    // A pre-broadcast failure (createTx/signPsbt) conservatively burns budget too;
    // that is the deliberate fail-closed trade the co-signer already makes, and it
    // keeps this from being the one guardrail whose ceiling stops binding on error.
    // At-most-once on the automated rail. When the caller supplies a stable
    // idempotencyKey, a retry after a post-broadcast throw is REFUSED rather
    // than re-broadcast: submitInner can throw after the tx already landed
    // (CONFIRMATION_TIMEOUT on the indexer wait, a lost ACK), and a naive
    // agent retry would otherwise build and pay a SECOND transaction. The
    // refusal carries the prior txid (when known) so the agent can resume
    // waiting on the existing payment instead of re-sending. Opt-in: absent a
    // key, behavior is unchanged. Fail-closed and needs no indexer to hold.
    const idempotencyKey = submitOpts && submitOpts.idempotencyKey;
    // BREAKING: the key is REQUIRED rather than honored when offered.
    // Opt-in idempotency protects only the callers who already knew to
    // ask, and the caller who does not know is exactly the automated agent that
    // retries a timed-out submit and pays twice. Refusing here costs a caller one
    // argument; the alternative costs a duplicate payment. allowUnkeyedSubmits
    // restores the old behavior for a caller who has decided that is acceptable.
    if ((idempotencyKey === undefined || idempotencyKey === null) && !session.policy.allowUnkeyedSubmits)
        session.deny('POLICY_IDEMPOTENCY_REQUIRED',
            'a spend-capable submit needs a stable submitOpts.idempotencyKey so a retry after a lost ' +
            'acknowledgement is refused instead of paying twice. Set allowUnkeyedSubmits: true to opt out.',
            { action: evaluation.action });
    if (idempotencyKey !== undefined && idempotencyKey !== null) {
        const keyStr = String(idempotencyKey);
        const prior = session.pruned().entries.find((e) => e.key === keyStr);
        if (prior)
            session.deny('POLICY_DUPLICATE_SUBMIT',
                `a submission with idempotencyKey ${keyStr} was already recorded` +
                ` (keys are remembered for ${session.policy.idempotencyHours}h)` +
                (prior.txid ? ` (txid ${prior.txid})` : '') +
                '; not broadcasting again. Resume the existing payment instead of retrying.',
                { idempotencyKey: keyStr, txid: prior.txid || null });
    }
    return session.recordUsage(evaluation, null, idempotencyKey);
}
class AgentSession extends WalletSession {
    constructor(sdk, wif, policy = {}, opts = {}) {
        super(sdk, wif, opts);
        const win = validatePolicy(policy);
        this.policy = {
            allowedActions:      new Set(policy.allowedActions.map((a) => String(a).toUpperCase())),
            allowedDestinations: policy.allowedDestinations ? new Set(policy.allowedDestinations) : null,
            maxPerAction:        policy.maxPerAction || null,
            maxPerWindow:        win,
            confirmAbove:        policy.confirmAbove || null,
            // Resolves ^<id> wire-form tick references (see policyEvaluator). The
            // client-side check usually sees pre-compaction names, but a caller
            // may pass a ^id tick directly, and the co-signer daemon relies on it.
            tickIds:             policy.tickIds || null,
            onPolicyViolation:   policy.onPolicyViolation || null,
            allowUnbounded:      policy.allowUnbounded === true,
            // Absent an idempotency key a retry after a lost ACK builds and pays a
            // SECOND transaction, so the key is required on the automated rail rather
            // than offered. Same opt-in shape as allowUnbounded.
            allowUnkeyedSubmits: policy.allowUnkeyedSubmits === true,
            // Retention horizon for idempotency keys, independent of maxPerWindow.
            // 30 days by default: long enough that no realistic retry outlives it,
            // bounded so the state file cannot grow without limit.
            idempotencyHours:    policy.idempotencyHours === undefined ? 720 : policy.idempotencyHours,
        };

        // Operator kill switch. Two halves, because they answer different
        // questions: `pause()` stops THIS object, and the file stops a session the
        // operator can no longer call into, which is the case that mattered - once an
        // agent holding the WIF is running, killing the process was the only lever.
        // Checked at the submit chokepoint, so a paused session refuses before any
        // policy evaluation, budget consumption or broadcast.
        this.paused = policy.paused === true;
        this._killSwitchFile = policy.killSwitchFile || opts.killSwitchFile
            || path.join(os.homedir(), '.xchain', `agent-halt-${this.address}`);

        // Window usage persists across restarts so a crash-loop can't reset caps.
        this._stateFile = policy.stateFile || opts.stateFile
            || path.join(os.homedir(), '.xchain', `agent-usage-${this.address}.json`);
        this._usage = null;   // lazy-loaded
    }

    /* ── kill switch ───────────────────────────────────────────────── */

    // Stop / resume THIS session. The file half below covers the operator who
    // cannot reach the object; these cover the caller who can.
    pause()  { this.paused = true; }
    resume() { this.paused = false; }

    // Is a halt in force? The file is re-read on EVERY submit rather than cached:
    // the point of the switch is that an operator can drop it beside a session
    // that is already running, so a cached answer would defeat it. A read error
    // other than "absent" halts too (fail-closed, matching loadUsage).
    haltReason() {
        if (this.paused) return 'this session is paused (resume() to continue)';
        try {
            fs.accessSync(this._killSwitchFile);
        } catch (e) {
            if (e && e.code === 'ENOENT') return null;
            return `kill-switch file ${this._killSwitchFile} is unreadable (${e.code || 'error'})`;
        }
        return `kill-switch file ${this._killSwitchFile} is present`;
    }

    /* ── policy evaluation ─────────────────────────────────────────── */

    deny(code, message, details) {
        const violation = Object.assign({ code, message, address: this.address }, details);
        if (this.policy.onPolicyViolation) {
            try { this.policy.onPolicyViolation(violation); } catch (e) { /* observer must never break enforcement */ }
        }
        throw new SDKPolicyError(code, message, violation);
    }

    evaluate(actionData) {
        // Pass the live window snapshot to the pure evaluator (it does no I/O).
        // Only read the window when the policy actually has a window rule.
        const windowUsage = this.policy.maxPerWindow ? this.computeWindowUsage() : undefined;
        const verdict = evaluatePolicy(this.policy, actionData, windowUsage);
        if (!verdict.ok)
            this.deny(verdict.violation.code, verdict.violation.message, verdict.violation.details);
        return verdict.evaluation;
    }

    /* ── window persistence ────────────────────────────────────────── */

    loadUsage() {
        if (this._usage) return this._usage;
        try {
            if (fs.existsSync(this._stateFile)) {
                const parsed = JSON.parse(fs.readFileSync(this._stateFile, 'utf8'));
                if (!Array.isArray(parsed.entries)) throw new Error('entries missing');
                this._usage = parsed;
            } else {
                this._usage = { entries: [] };
            }
        } catch (e) {
            // Fail CLOSED: a corrupt usage file must not silently reset the window.
            throw new SDKPolicyError('POLICY_STATE_CORRUPT',
                `agent usage state at ${this._stateFile} is unreadable (${e.message}); ` +
                'inspect/remove it deliberately to reset the spending window', { stateFile: this._stateFile });
        }
        return this._usage;
    }

    // Two cutoffs, because a spend window and an at-most-once record answer
    // different questions. An idempotency key that dies with the window lets an
    // identical retry one window later re-broadcast and pay a SECOND time, against a
    // submit_action that advertises at-most-once without qualification. A keyed row
    // therefore outlives its window, COMPACTED to { t, key, txid }: action, tick and
    // amount are dropped so an aged-out row can never be summed into a spend cap
    // even if some future caller sums the raw list. computeWindowUsage() filters by the
    // window cutoff regardless, which is the belt to this brace.
    pruned() {
        const usage = this.loadUsage();
        const win = this.policy.maxPerWindow;
        if (win) {
            const now = Date.now();
            const windowCutoff = now - win.hours * 3600 * 1000;
            const keyCutoff = now - this.policy.idempotencyHours * 3600 * 1000;
            const kept = [];
            for (const e of usage.entries) {
                if (e.t >= windowCutoff) { kept.push(e); continue; }
                if (e.key !== undefined && e.key !== null && e.t >= keyCutoff)
                    kept.push({ t: e.t, key: e.key, txid: e.txid === undefined ? null : e.txid });
            }
            usage.entries = kept;
        }
        return usage;
    }

    // Mirrors windowStore.snapshot(). The two stores feed the SAME evaluator, so a
    // divergence here is a policy hole only on the client side, where nothing
    // validates the tick charset (validateDecodedParams runs on the daemon decode
    // path alone).
    //
    // G1: null prototype. A caller-supplied tick of 'constructor'/'toString'/
    // 'valueOf' would otherwise read back an inherited FUNCTION, and
    // addDecimal(fn, amount) throws on every later evaluation until the entry ages
    // out; a tick of '__proto__' would make the write a silent prototype-set, so
    // that spend never counts against its cap.
    //
    // G8: an entry whose tick never resolved still accumulates, under the reserved
    // bucket the evaluator reads for exactly that case (COLLECT v0, UNSTAKE v0, any
    // future amount-without-TICK shape). Skipping them made a wildcard window cap
    // read a used total of '0' forever, binding each transaction independently.
    //
    // The window cutoff is applied HERE as well as in pruned(), because pruned()
    // now retains aged-out keyed rows for the at-most-once guard. Counting those
    // rows would let a spent-and-expired submission keep consuming maxActions and
    // perTick budget forever, which is the one way this retention could deny a
    // legitimate payment.
    computeWindowUsage() {
        const usage = this.pruned();
        const win = this.policy.maxPerWindow;
        const cutoff = win ? Date.now() - win.hours * 3600 * 1000 : -Infinity;
        const inWindow = usage.entries.filter((e) => e.t >= cutoff);
        const perTick = Object.create(null);
        for (const e of inWindow) {
            if (e.amount === undefined) continue;
            const key = e.tick === undefined || e.tick === null
                ? UNRESOLVED_TICK_BUCKET : String(e.tick);
            perTick[key] = addDecimal(perTick[key] || '0', e.amount);
        }
        return { count: inWindow.length, perTick, hours: win ? win.hours : null };
    }

    // Append one window entry and persist. Returns the pushed entry (a live reference
    // into this._usage) so the caller can patch its txid in once the broadcast lands.
    recordUsage(evaluation, txid, key) {
        const usage = this.pruned();
        const entry = {
            t: Date.now(), action: evaluation.action,
            tick: evaluation.tick, amount: evaluation.amount, txid,
        };
        // Only stamp an idempotency key when one was supplied, so entries stay
        // byte-identical to the legacy shape when the feature is unused.
        if (key !== undefined && key !== null) entry.key = String(key);
        usage.entries.push(entry);
        this.persistUsage(usage);
        return entry;
    }

    // Patch the real txid into an entry recorded provisionally on authorization, after
    // the broadcast succeeds. `entry` is a live reference inside this._usage (submits
    // are serialized on _submitTail, so nothing re-prunes it between record and patch),
    // so mutate it in place and re-persist. No-op when there is no txid to record.
    patchUsageTxid(entry, txid) {
        if (!entry || !txid) return;
        entry.txid = txid;
        this.persistUsage(this._usage);
    }

    persistUsage(usage) {
        fs.mkdirSync(path.dirname(this._stateFile), { recursive: true });
        const tmp = this._stateFile + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(usage));
        fs.renameSync(tmp, this._stateFile);
        this._usage = usage;
    }

    /* ── enforcement chokepoint ────────────────────────────────────── */

    async submit(actionData, encoderOpts = {}, submitOpts = {}) {
        // The window-cap check (evaluate reads the usage window) and the record
        // (recordUsage writes it) must be atomic with the broadcast, or two
        // concurrent submits both evaluate against the same pre-record snapshot,
        // both pass, and together exceed maxPerWindow (maxActions / per-tick caps)
        // -- silently defeating the bounded-blast-radius the AgentSession exists
        // to provide. Serialize the whole enforce+submit+record on the shared
        // per-session tail (the parent's submit uses the same tail). We call the
        // parent's UNLOCKED submitInner inside, not super.submit, so we don't
        // re-enqueue on the tail we already hold (which would deadlock).
        let run = this._submitTail.then(() => this.enforceAndSubmit(actionData, encoderOpts, submitOpts));
        this._submitTail = run.then(() => {}, () => {});
        return run;
    }

    async enforceAndSubmit(actionData, encoderOpts, submitOpts) {
        // FIRST, before evaluation, budget consumption or any broadcast: a halted
        // session must refuse without side effects.
        const halt = this.haltReason();
        if (halt)
            this.deny('POLICY_HALTED', `AgentSession is halted: ${halt}`, { killSwitchFile: this._killSwitchFile });

        const evaluation = this.evaluate(actionData);

        if (evaluation.needsConfirmation) {
            const ok = await this.policy.confirmAbove.handler({
                action: evaluation.action, tick: evaluation.tick, amount: evaluation.amount,
                destinations: evaluation.destinations, address: this.address,
                windowUsage: this.computeWindowUsage(),
            });
            if (!ok)
                this.deny('POLICY_CONFIRMATION_DENIED',
                    `${evaluation.action} of ${evaluation.amount} ${evaluation.tick || ''} was not confirmed`,
                    { action: evaluation.action, tick: evaluation.tick, amount: evaluation.amount });
        }

        const entry = authorizeSubmission(this, evaluation, submitOpts);
        let result;
        try {
            result = await super.submitInner(actionData, encoderOpts, submitOpts);
        } catch (err) {
            // A throw AFTER broadcast carries the txid (e.g. CONFIRMATION_TIMEOUT).
            // Patch it onto the provisional entry so the audit record is not left
            // with txid:null and a later duplicate-key refusal can return it.
            if (err && err.details && err.details.txid) this.patchUsageTxid(entry, err.details.txid);
            throw err;
        }
        this.patchUsageTxid(entry, result && result.txid);

        // Surface what was evaluated so callers (MCP write tools) can report
        // remaining budget without re-deriving policy state.
        result.policy = {
            action: evaluation.action, tick: evaluation.tick, amount: evaluation.amount,
            confirmed: evaluation.needsConfirmation || undefined,
            windowUsage: this.computeWindowUsage(),
        };
        return result;
    }
}

module.exports = AgentSession;
