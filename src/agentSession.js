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
 *       onPolicyViolation: (violation) => { ... },         // observe denials
 *       stateFile: '/path/to/usage.json'                   // window persistence
 *   });
 *   await agent.send({ tick: 'MYTOKEN', amount: '5', destination: addr });
 *
 * HONESTY NOTE: this is a client-side guardrail, not a security
 * boundary: whoever holds the WIF can bypass it with raw SDK calls.
 * The hard-enforcement upgrade path is a MuSig2 co-signer that refuses
 * to co-sign out-of-policy PSBTs (interface spec'd, not yet built).
 *
 ********************************************************************/

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const WalletSession    = require('./walletSession.js');
const { SDKPolicyError } = require('./errors.js');
// The pure policy verdict is shared with the co-signer daemon so both
// enforcement points run identical logic. AgentSession adds the throw +
// observer + file-backed window store around it.
const { evaluatePolicy, addDecimal } = require('./cosigner/policyEvaluator.js');

class AgentSession extends WalletSession {

    constructor(sdk, wif, policy = {}, opts = {}) {
        super(sdk, wif, opts);

        if (!Array.isArray(policy.allowedActions) || policy.allowedActions.length === 0)
            throw new SDKPolicyError('POLICY_INVALID',
                'AgentSession requires a non-empty allowedActions list (fail-closed: nothing is allowed by default)');

        const win = policy.maxPerWindow || null;
        if (win && (!Number.isFinite(win.hours) || win.hours <= 0))
            throw new SDKPolicyError('POLICY_INVALID', 'maxPerWindow.hours must be a positive number');
        if (policy.confirmAbove && typeof policy.confirmAbove.handler !== 'function')
            throw new SDKPolicyError('POLICY_INVALID', 'confirmAbove requires a handler function');

        this.policy = {
            allowedActions:      new Set(policy.allowedActions.map((a) => String(a).toUpperCase())),
            allowedDestinations: policy.allowedDestinations ? new Set(policy.allowedDestinations) : null,
            maxPerAction:        policy.maxPerAction || null,
            maxPerWindow:        win,
            confirmAbove:        policy.confirmAbove || null,
            onPolicyViolation:   policy.onPolicyViolation || null,
        };

        // Window usage persists across restarts so a crash-loop can't reset caps.
        this._stateFile = policy.stateFile || opts.stateFile
            || path.join(os.homedir(), '.xchain', `agent-usage-${this.address}.json`);
        this._usage = null;   // lazy-loaded
    }

    /* ── policy evaluation ─────────────────────────────────────────── */

    _deny(code, message, details) {
        const violation = Object.assign({ code, message, address: this.address }, details);
        if (this.policy.onPolicyViolation) {
            try { this.policy.onPolicyViolation(violation); } catch (e) { /* observer must never break enforcement */ }
        }
        throw new SDKPolicyError(code, message, violation);
    }

    _evaluate(actionData) {
        // Pass the live window snapshot to the pure evaluator (it does no I/O).
        // Only read the window when the policy actually has a window rule.
        const windowUsage = this.policy.maxPerWindow ? this._windowUsage() : undefined;
        const verdict = evaluatePolicy(this.policy, actionData, windowUsage);
        if (!verdict.ok)
            this._deny(verdict.violation.code, verdict.violation.message, verdict.violation.details);
        return verdict.evaluation;
    }

    /* ── window persistence ────────────────────────────────────────── */

    _loadUsage() {
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

    _pruned() {
        const usage = this._loadUsage();
        const win = this.policy.maxPerWindow;
        if (win) {
            const cutoff = Date.now() - win.hours * 3600 * 1000;
            usage.entries = usage.entries.filter((e) => e.t >= cutoff);
        }
        return usage;
    }

    _windowUsage() {
        const usage = this._pruned();
        const perTick = {};
        for (const e of usage.entries)
            if (e.tick !== undefined && e.amount !== undefined)
                perTick[e.tick] = addDecimal(perTick[e.tick] || '0', e.amount);
        return { count: usage.entries.length, perTick, hours: this.policy.maxPerWindow ? this.policy.maxPerWindow.hours : null };
    }

    _recordUsage(evaluation, txid) {
        const usage = this._pruned();
        usage.entries.push({
            t: Date.now(), action: evaluation.action,
            tick: evaluation.tick, amount: evaluation.amount, txid,
        });
        fs.mkdirSync(path.dirname(this._stateFile), { recursive: true });
        const tmp = this._stateFile + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(usage));
        fs.renameSync(tmp, this._stateFile);
        this._usage = usage;
    }

    /* ── enforcement chokepoint ────────────────────────────────────── */

    async submit(actionData, encoderOpts = {}, submitOpts = {}) {
        const evaluation = this._evaluate(actionData);

        if (evaluation.needsConfirmation) {
            const ok = await this.policy.confirmAbove.handler({
                action: evaluation.action, tick: evaluation.tick, amount: evaluation.amount,
                destinations: evaluation.destinations, address: this.address,
                windowUsage: this._windowUsage(),
            });
            if (!ok)
                this._deny('POLICY_CONFIRMATION_DENIED',
                    `${evaluation.action} of ${evaluation.amount} ${evaluation.tick || ''} was not confirmed`,
                    { action: evaluation.action, tick: evaluation.tick, amount: evaluation.amount });
        }

        const result = await super.submit(actionData, encoderOpts, submitOpts);
        this._recordUsage(evaluation, result && result.txid);

        // Surface what was evaluated so callers (MCP write tools) can report
        // remaining budget without re-deriving policy state.
        result.policy = {
            action: evaluation.action, tick: evaluation.tick, amount: evaluation.amount,
            confirmed: evaluation.needsConfirmation || undefined,
            windowUsage: this._windowUsage(),
        };
        return result;
    }
}

module.exports = AgentSession;
