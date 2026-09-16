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
 * XChain Platform SDK - XChainSDK (Software Development Kit)
 *
 * This file handles parsing XChain Platform SDK requests
 *
 ********************************************************************/

const ContractUtils = require('../contract/utils.js');
// The frozen CONTRACT_MANIFEST meta verdict strings (spec 2.3), so the deploy
// pre-flight compares against the token itself rather than a retyped copy.
const CONTRACT_META_VERDICTS = ContractUtils.META_VERDICTS;
const ContractClient = require('../contract/client.js');
const WalletSession = require('../utils/wallet_session.js');
const AgentSession = require('../cosigner/agent_session.js');
const MuSig2AgentSession = require('../cosigner/musig2_agent_session.js');
const { getLogger } = require('../observability/logger.js');
const log = getLogger('xchain-sdk');
const { SDKContractError } = require('../utils/errors.js');
const { lintSource } = require('../contract/lint_core.js');
const CONTRACT_SOURCES = require('../contract/templates.js');
const chunkHelper = require('../contract/chunk_helper.js');

// Keep contract checks and signing sessions together because they share deploy policy.
module.exports = {

    // Pre-flight lint of raw contract source (plain JS, pre-base64). Advisory,
    // synchronous, no network, browser-safe; runs every acorn-coverable deploy
    // check via the vendored lint_core. The isolated-vm V8 syntax compile runs
    // only at deploy/CLI, so authoritative is always false; the CLI / on-chain
    // deploy has the final word.
    // @returns {{ valid:boolean, errors:Rule[], warnings:Rule[], authoritative:false }}
    validateContract(code) {
        const { errors, warnings } = lintSource(code);
        return { valid: errors.length === 0, errors, warnings, authoritative: false };
    },

    // Return the source of a contract template or pattern by name, ready to
    // customize and deploy (synchronous, no network, browser-safe). Sources are
    // the audited xchain-contracts library, embedded at build time. Templates:
    // 'escrow' | 'vesting' | 'crowdsale' | 'amm'. Patterns: 'access-control' |
    // 'pausable' | 'safe-transfer' | 'validation' | 'state-machine'.
    // Throws SDKContractError('TEMPLATE_NOT_FOUND') for an unknown name.
    scaffold(name) {
        const b64 = (CONTRACT_SOURCES.templates && CONTRACT_SOURCES.templates[name]) ||
                    (CONTRACT_SOURCES.patterns && CONTRACT_SOURCES.patterns[name]);
        // An unknown template name is an error, and the message lists the names that do exist.
        if (!b64) {
            const avail = this.listTemplates();
            throw new SDKContractError('TEMPLATE_NOT_FOUND',
                'No template or pattern named "' + name + '". Available templates: ' +
                avail.templates.join(', ') + '; patterns: ' + avail.patterns.join(', '));
        }
        return Buffer.from(b64, 'base64').toString('utf8');
    },

    // List the available scaffold names: { templates: [...], patterns: [...] }.
    listTemplates() {
        return {
            templates: Object.keys(CONTRACT_SOURCES.templates || {}),
            patterns:  Object.keys(CONTRACT_SOURCES.patterns || {})
        };
    },

    // Plan a deploy WITHOUT signing: does this source fit one inline DEPLOY, or
    // does it need chunking? Returns { codeHash, single, parts, totalChunks }
    // (synchronous, no network, no key material, browser-safe).
    //
    // deployContract() is the batteries-included path, but it takes a WIF and
    // drives its own session, so a signer that does NOT hold raw keys - a
    // wallet signing through a vault, a hardware device, or an offline
    // co-signer - cannot use it. Those callers need the same consensus-exact
    // chunk math (MAX_ACTION_DATA_LENGTH / MAX_DEPLOYCHUNK_PART_BYTES /
    // MAX_DEPLOY_CHUNKS and the base64 + push-prefix overhead) to build the
    // carrier + assembling actions on their own signing path; re-deriving it
    // caller-side would drift from consensus at the cap. Throws when the source
    // needs more than MAX_DEPLOY_CHUNKS slices.
    //
    // opts: { gasLimit, constructorParams, cooldownBlocks, slashDestination }. A
    // stakeable deploy MUST pass its staking fields: they select DEPLOY v1, whose
    // COOLDOWN_BLOCKS|SLASH_DESTINATION tail is part of the action being sized.
    planDeploy(code, opts) {
        return chunkHelper.planDeploy(String(code), opts || {});
    },

    // Lint params.CODE (raw source) before a DEPLOY action is built.
    //   'block' (default): throw on any error (saves a guaranteed-to-fail on-chain tx)
    //   'warn'           : log errors + warnings, proceed
    //   'off'            : skip entirely
    // Chunked/hash-only deploys (no inline CODE) are skipped here; deployContract()
    // lints the assembled source before chunking instead.
    _preflightContractLint(params, mode) {
        mode = mode || 'block';
        if (mode === 'off') return;

        let code;
        if (params && typeof params.CODE === 'string') code = params.CODE;
        else if (params && typeof params.CODE_ENCODING === 'string') {
            try { code = this.contracts.decode(params.CODE_ENCODING); } catch (e) { return; }
        }
        if (typeof code !== 'string') {
            // The lint deliberately reads only the wire spelling. Contract identity is a
            // fee-saving refusal, so it also runs over the camelCase spelling the session
            // and workflow seams take: a nameless deploy({ code }) is refused like a
            // nameless deploy({ CODE }).
            this._preflightContractMeta(this._contractSourceFromParams(params), mode);
            return;
        }

        const result = this.validateContract(code);
        for (const w of result.warnings)
            log.warn('DEPLOY lint warning: ' + w.message);

        // Constructor footgun: a contract that exports `initialize` (a constructor)
        // deployed with no CONSTRUCTOR_PARAMS runs no constructor, so it silently
        // deploys uninitialized. Nudge the caller (never blocks). An empty value is
        // still "provided" and runs a zero-arg initialize once DEPLOY_INIT_STRICT is
        // live, so only a genuinely-absent field warns. Best-effort: detection never
        // throws into the deploy path.
        try {
            const cp = params ? (params.CONSTRUCTOR_PARAMS !== undefined ? params.CONSTRUCTOR_PARAMS : params.constructorParams) : undefined;
            const ctorParamsAbsent = cp === undefined || cp === null || cp === '' || (Array.isArray(cp) && cp.length === 0);
            if (ctorParamsAbsent && this.contracts.getExportedMethodNames(code).includes('initialize'))
                log.warn('DEPLOY warning: contract exports initialize() but no CONSTRUCTOR_PARAMS were provided; ' +
                    'it will deploy uninitialized (and is rejected on-chain once the DEPLOY_INIT_STRICT flag-day activates). ' +
                    'Pass constructorParams (an empty value runs a zero-arg initialize).');
        } catch (e) { /* best-effort nudge; never block a deploy on it */ }

        if (result.valid) {
            // Contract identity is judged AFTER the lint verdict because the chain judges
            // it after validateSyntax: a contract broken on both reports the syntax error.
            this._preflightContractMeta(code, mode);
            return;
        }

        if (mode === 'warn') {
            for (const e of result.errors)
                log.warn('DEPLOY lint error: ' + e.message);
            this._preflightContractMeta(code, mode);
            return;
        }
        // 'block'
        const first = result.errors[0];
        const more = result.errors.length > 1 ? ' (+' + (result.errors.length - 1) + ' more)' : '';
        throw new SDKContractError('CONTRACT_LINT_FAILED',
            'Contract failed pre-flight validation: ' + first.message + more +
            ". Fix the contract or pass { lint: 'off' } to skip (it would still be rejected at deploy).");
    },

    // The contract source a DEPLOY's params carry, or undefined. Accepts the
    // UPPER_SNAKE wire spelling and the camelCase one the session/workflow seams take
    // (actions.js normalizes them later, after the point a pre-flight is worth
    // anything), so `code` is pre-flighted the same way `CODE` is.
    _contractSourceFromParams(params) {
        if (!params) return undefined;
        if (typeof params.CODE === 'string') return params.CODE;
        if (typeof params.code === 'string') return params.code;
        let enc = typeof params.CODE_ENCODING === 'string' ? params.CODE_ENCODING
                : (typeof params.codeEncoding === 'string' ? params.codeEncoding : undefined);
        if (typeof enc !== 'string') return undefined;
        try { return this.contracts.decode(enc); } catch (e) { return undefined; }
    },

    // Contract identity (`meta`) pre-flight, spec 2.3 / CONTRACT_META_REQUIRED.
    // Shared by every deploy seam so one refusal rule covers sdk.deploy(),
    // walletSession.deploy/deployChunk and the workflows built on them.
    //   'block' (default): throw with the exact consensus string the chain would
    //                      write, BEFORE the action is composed, so no fee is paid for
    //                      a deploy the chain will reject;
    //   'warn'           : log the same string and proceed;
    //   'off'            : skip.
    // Only a PROVEN failure refuses (no meta at all, or a string literal that fails the
    // byte grammar). Computed meta and any shape the static walk cannot read are
    // advisories: the chain evaluates meta in the isolate, and the SDK must never
    // refuse a contract the chain would accept.
    _preflightContractMeta(code, mode) {
        // `false` is accepted as 'off' because the session's submit options already
        // carry a `preflight` key for the action pre-flight engine, whose off value is
        // false; a caller who turned that off never meant to be blocked here either.
        if (mode === false || mode === 'off') return;
        // 'report' is the action pre-flight engine's non-blocking mode and means the
        // same thing here; every other value (including its 'enforce'/'local') blocks,
        // which is the safe default for a check that saves a fee.
        mode = (mode === 'warn' || mode === 'report') ? 'warn' : 'block';
        if (typeof code !== 'string') return;

        let verdict;
        // Best-effort: a detector fault must never block a deploy on its own.
        try { verdict = this.contracts.checkExportedMeta(code); } catch (e) { return; }

        for (const a of verdict.advisories)
            log.warn('DEPLOY meta advisory: ' + a);

        if (!verdict.error) return;

        if (mode === 'warn') {
            log.warn('DEPLOY meta error: ' + verdict.error);
            return;
        }
        const isRequired = verdict.error === CONTRACT_META_VERDICTS.REQUIRED;
        throw new SDKContractError(
            isRequired ? 'CONTRACT_META_REQUIRED' : 'CONTRACT_META_INVALID',
            verdict.error,
            {
                verdict: verdict.error,
                hint: isRequired
                    ? "export meta: { name, description, version } as the first key of the contract, " +
                      "or pass { preflight: 'off' } / { lint: 'off' } to skip (the deploy would still be rejected on-chain)"
                    : "fix the meta field to match the consensus grammar, or pass { preflight: 'off' } / " +
                      "{ lint: 'off' } to skip (the deploy would still be rejected on-chain)"
            });
    },

    async deploy(params, encoder, opts = {}) {
        this._preflightContractLint(params, opts.lint);
        return this.createAction({ action: 'DEPLOY', params, encoder });
    },
    async execute(params, encoder)   { return this.createAction({ action: 'EXECUTE', params, encoder }); },
    async deposit(params, encoder)   { return this.createAction({ action: 'DEPOSIT', params, encoder }); },
    async withdraw(params, encoder)  { return this.createAction({ action: 'WITHDRAW', params, encoder }); },

    contract(contractActionIndex) {
        return new ContractClient(this, contractActionIndex);
    },

    // Usage: let w = sdk.session(wif); await w.send({...}); await w.issue({...});
    session(wif, opts) {
        return new WalletSession(this, wif, opts);
    },

    // Create a policy-bounded session for an AUTOMATED AGENT: same surface as
    // session(), but every submit is checked against a declarative spending
    // policy (action allowlist, per-action and per-window caps, destination
    // allowlist, confirmation hook). Fail-closed. See src/cosigner/agent_session.js.
    agentSession(wif, policy, opts) {
        return new AgentSession(this, wif, policy, opts);
    },

    // Create a HARD-enforced agent session: the spending account is a 2-of-2
    // MuSig2 P2TR (agent key + policy co-signer key), so the WIF holder can't
    // bypass policy with raw SDK calls - the co-signer withholds its partial on
    // out-of-policy actions. opts.coSigner = { transport, publicKeys, network? };
    // the agent's own pubkey must be in publicKeys. See src/cosigner/musig2_agent_session.js.
    musig2AgentSession(wif, policy, opts) {
        return new MuSig2AgentSession(this, wif, policy, opts);
    },
};
