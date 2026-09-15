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
 * XChain Platform SDK - Workflow Recipes
 *
 * High-level helpers that compose multiple actions into common
 * workflows. Built on WalletSession + submitAction.
 *
 ********************************************************************/

const chunkHelper = require('../../contract/chunk_helper.js');

function prepareDeploy(owner, deployParams, opts) {
    const code = (deployParams.code !== undefined) ? deployParams.code : deployParams.CODE;
    const gasLimit = (deployParams.gasLimit !== undefined) ? deployParams.gasLimit : deployParams.GAS_LIMIT;
    const ctor = (deployParams.constructorParams !== undefined) ? deployParams.constructorParams : deployParams.CONSTRUCTOR_PARAMS;
    const cooldown = (deployParams.cooldownBlocks !== undefined) ? deployParams.cooldownBlocks : deployParams.COOLDOWN_BLOCKS;
    const slashDst = (deployParams.slashDestination !== undefined) ? deployParams.slashDestination : deployParams.SLASH_DESTINATION;
    // EITHER staking field populated makes this a staking deploy, which is the
    // rule chunkHelper.deployOverhead and FormatSelector already apply. Gating on
    // cooldown alone dropped a populated slashDestination out of assembleParams
    // and shipped DEPLOY v2, so a config the inline path refuses (validator.js:
    // 'SLASH_DESTINATION requires COOLDOWN_BLOCKS', mirroring the indexer)
    // silently became a non-stakeable contract whenever the source was large
    // enough to chunk. Carrying the field through instead reaches that same
    // refusal in _assertAssemblerFits, before any carrier is broadcast.
    const populated = (v) => (v !== undefined && v !== null && v !== '');
    const hasStaking = populated(cooldown) || populated(slashDst);

    // Pre-flight lint the fully-assembled source ONCE, before chunking, so the
    // single-shot and chunked paths share one verdict (default 'block'; pass
    // opts.lint = 'warn' | 'off' to relax). Skipped when the caller pre-encoded.
    if (code !== undefined && code !== null)
        owner.sdk._preflightContractLint({ CODE: String(code) }, opts.lint);

    // No raw code (caller pre-encoded) → defer to the normal single-shot deploy.
    // The staking fields go in too: they are what selects DEPLOY v1, and a plan
    // sized on the v0 shape budgets none of that tail, so a stakeable contract
    // landing within those bytes of the cap is planned single-shot and refused
    // by the encoder instead of being chunked.
    const plan = (code !== undefined && code !== null)
        ? chunkHelper.planDeploy(String(code), {
            gasLimit, constructorParams: ctor,
            cooldownBlocks: cooldown, slashDestination: slashDst
        })
        : { single: true };

    // Phase-2 params, built BEFORE Phase 1 so the assembler can be sized while
    // no money has moved. CODE_HASH (no inline code) selects DEPLOY v2; staking → v3.
    let assembleParams = null;
    if (!plan.single) {
        assembleParams = {
            version: hasStaking ? '3' : '2', codeHash: plan.codeHash,
            gasLimit, constructorParams: (ctor !== undefined) ? ctor : []
        };
        if (hasStaking) {
            assembleParams.cooldownBlocks = cooldown;
            assembleParams.slashDestination = slashDst;
        }
        owner._assertAssemblerFits(assembleParams);
    }
    return { plan, assembleParams };
}

async function executeDeploy(owner, session, deployParams, deposits, opts, prepared, p) {
    const { plan, assembleParams } = prepared;
    if (plan.single) {
        p.deploy = await session.deploy(deployParams, {}, opts);
        // An inline deploy IS the contract's action, so its own indexed row
        // answers the index and there is nothing to resolve.
        p.contractActionIndex = owner._actionIndexOf(p.deploy.indexed);
    } else {
        // Phase 1: each ordered base64 slice as its own DEPLOY v4 carrier, confirmed in turn so
        // they are all on-chain (at lower action_index) before the assembling DEPLOY runs.
        for (let i = 0; i < plan.parts.length; i++) {
            p.chunks.push(await session.deployChunk({
                codeHash: plan.codeHash, chunkIndex: i,
                totalChunks: plan.totalChunks, codePart: plan.parts[i]
            }, {}, opts));
        }
        // Phase 2: assemble (params + size already pre-flighted above).
        p.deploy = await session.deploy(assembleParams, {}, opts);

        // A chunk group deploys at whichever piece COMPLETES it, which need
        // not be the assembler: a reorg can re-pack a correctly sequenced
        // group assembler-first, and the contract then lives at a carrier's
        // index. The assembler's own indexed row cannot know that, so ask the
        // explorer. Skipped when the assembler's index is unresolvable, which
        // is the caller submitting without an indexer wait: there is then no
        // action to look up and the deposit leg below refuses as it always has.
        const assemblerActionIndex = owner._actionIndexOf(p.deploy.indexed);
        if (assemblerActionIndex !== undefined && assemblerActionIndex !== null)
            p.contractActionIndex = await owner.resolveDeployedContract(assemblerActionIndex, opts);
    }

    if (deposits && deposits.length > 0) {
        // Same refusal as deployAndFund above: a caller that asked for deposits
        // and got a SUCCESS carrying none was told the contract is funded when
        // it is not. The index comes from the resolution above rather than from
        // indexed.action_index, so a deferred group funds the contract that was
        // actually deployed instead of an assembler that deployed nothing.
        const contractActionIndex = p.contractActionIndex;
        if (contractActionIndex === undefined || contractActionIndex === null)
            throw new Error('deployContract: DEPLOY action_index unavailable; submit with waitForIndexer enabled');
        for (const dep of deposits)
            p.deposits.push(await session.deposit({ contractActionIndex, tick: dep.tick, quantity: dep.quantity }, {}, opts));
    }
    return p;
}

function inspectDeploymentDetail(owner, detail, assemblerActionIndex) {
    let observed = null;
    const hasIndex = Object.prototype.hasOwnProperty.call(detail, 'deployed_contract_index');
    const hasStatus = Object.prototype.hasOwnProperty.call(detail, 'assembly_status');
    const index = detail.deployed_contract_index;
    if (hasIndex && index !== undefined && index !== null)
        return { contractActionIndex: index, observed };

    if (hasIndex || hasStatus) {
        // The explorer reports the pair. A status that has stopped being
        // `pending` while no contract index exists means the group settled
        // without deploying (a hash mismatch or a source drained of gas at
        // the completing carrier consumes the assembler), and nothing
        // retries that, so waiting out the timeout would only hide it.
        const status = detail.assembly_status;
        if (status !== undefined && status !== null) {
            observed = String(status);
            if (!/^pending/i.test(observed))
                throw owner._deployedContractFailure(assemblerActionIndex, observed);
        }
    } else {
        // An explorer from before the field landed reports only the
        // assembler's own status. That is the whole answer for a group
        // completed by the assembler itself and for one that failed
        // outright; a pending assembler it cannot resolve, so the poll
        // runs to the deadline and says which field was missing.
        const status = (detail.status === undefined || detail.status === null) ? '' : String(detail.status);
        if (status) observed = status;
        if (/^valid/i.test(status)) return { contractActionIndex: assemblerActionIndex, observed };
        if (/^invalid/i.test(status)) throw owner._deployedContractFailure(assemblerActionIndex, status);
    }
    return { contractActionIndex: null, observed };
}

function deploymentTimeoutError(assemblerActionIndex, timeout, observed, lastError) {
    const err = new Error('resolveDeployedContract: the explorer exposes no deployed_contract_index for DEPLOY '
        + assemblerActionIndex + ' after ' + timeout + 'ms'
        + (observed ? ' (last status: ' + observed + ')' : '')
        + (lastError ? ' (last read error: ' + lastError.message + ')' : ''));
    err.status = observed;
    err.actionIndex = assemblerActionIndex;
    if (lastError) err.cause = lastError;
    return err;
}

module.exports = {
    // Deploy a smart contract and optionally deposit initial tokens.
    //
    // wif           - WIF private key
    // deployParams  - DEPLOY action params (code/codeEncoding, gasLimit, constructorParams)
    // deposits      - [{ tick, quantity }, ...] (optional initial token deposits)
    // opts          - submit options, plus opts.preflight ('block' default | 'warn' |
    //                 'off'): the contract-identity check (CONTRACT_META_REQUIRED) runs
    //                 inside session.deploy BEFORE the action is composed, so a contract
    //                 the chain will reject for a missing or malformed `meta` never pays
    //                 a fee, and no deposit leg is attempted against a contract that
    //                 will not exist.
    //
    // Returns: { deploy: <submitResult>, deposits: [<submitResult>, ...] }
    async deployAndFund(wif, deployParams, deposits, opts = {}) {
        let session = this.sdk.session(wif, opts);
        return this._withPartial({ deploy: null, deposits: [] }, async (p) => {
            p.deploy = await session.deploy(deployParams, {}, opts);

            if (deposits && deposits.length > 0) {
                // The contract reference for the deposits. Reading indexed.action_index
                // directly saw `undefined` on the POLLING path, where the waiter resolves
                // a whole TRANSACTION ({ actions: [{ action_index }] }) rather than a
                // single action; `undefined` then passed a `!== null` guard and a DEPOSIT
                // was assembled with no contract reference at all, after the deploy had
                // been broadcast and paid for. _actionIndexOf resolves both shapes, which
                // is what every other flow in this file already uses it for.
                let contractActionIndex = this._actionIndexOf(p.deploy.indexed);
                // Nullish, not falsy: index 0 is a valid index and must fund. Throwing
                // rather than skipping matches attachContent and setRoster, because a
                // caller that asked for deposits and got a SUCCESS carrying none was told
                // the contract is funded when it is not. The throw sits inside
                // _withPartial, so the broadcast deploy comes back as err.partial.
                if (contractActionIndex === undefined || contractActionIndex === null)
                    throw new Error('deployAndFund: DEPLOY action_index unavailable; submit with waitForIndexer enabled');

                for (let dep of deposits) {
                    p.deposits.push(await session.deposit({
                        contractActionIndex,
                        tick:     dep.tick,
                        quantity: dep.quantity
                    }, {}, opts));
                }
            }

            return p;
        });
    },

    // Deploy a smart contract, AUTO-SELECTING single-shot vs chunked, then optionally
    // deposit initial tokens. If base64(code) fits one DEPLOY action it deploys inline
    // (DEPLOY v0/v1); otherwise it submits each base64 slice as a DEPLOY v4 carrier (awaiting
    // indexer confirmation per chunk) then an assembling DEPLOY v2/v3 carrying the
    // CODE_HASH. Pass raw `code` (not codeEncoding/codeHash) so the planner can size it.
    //
    // wif           - WIF private key
    // deployParams  - { code, gasLimit, constructorParams, [cooldownBlocks, slashDestination] }
    // deposits      - [{ tick, quantity }, ...] (optional initial token deposits)
    // opts          - submit options
    //
    // Returns: { deploy: <submitResult>, chunks: [<submitResult>...], deposits: [...],
    //            contractActionIndex: <the deployed contract's action_index> }
    async deployContract(wif, deployParams = {}, deposits, opts = {}) {
        const session = this.sdk.session(wif, opts);
        const prepared = prepareDeploy(this, deployParams, opts);
        return this._withPartial(
            { deploy: null, chunks: [], deposits: [], contractActionIndex: null },
            (p) => executeDeploy(this, session, deployParams, deposits, opts, prepared, p)
        );
    },

    // Resolve the contract a chunked DEPLOY produced, through the explorer.
    //
    // A chunk group deploys at whichever piece COMPLETES it, so the contract's
    // index is not knowable from the assembling DEPLOY's own row: it is A when the
    // carriers were already on chain (the sequential case), and a carrier's index C
    // when the group completed later. The explorer reports the answer on A's action
    // detail as `deployed_contract_index`, paired with `assembly_status` so a group
    // that settled WITHOUT deploying is distinguishable from one still waiting for
    // its chunks. Public and safely re-callable, which is what a client resuming a
    // deploy after a reorg needs.
    //
    // assemblerActionIndex - A, the assembling DEPLOY's action_index
    // opts:
    //   timeout      - ms to poll before giving up (default 120000)
    //   pollInterval - ms between reads (default 2000, the ActionWaiter's own)
    //
    // Returns the deployed contract's action_index, verbatim as the explorer
    // reports it (the same string-or-number shape _actionIndexOf hands back).
    // Throws when the group settled without a contract; the error carries the
    // reported status as `err.status` and A as `err.actionIndex`. A read that
    // throws is not a verdict (the ActionWaiter's own rule): the poll continues
    // and the last read error is reported at the deadline.
    async resolveDeployedContract(assemblerActionIndex, opts = {}) {
        if (assemblerActionIndex === undefined || assemblerActionIndex === null)
            throw new Error('resolveDeployedContract: an assembling DEPLOY action_index is required');

        let timeout      = opts.timeout > 0 ? opts.timeout : 120000;
        let pollInterval = opts.pollInterval > 0 ? opts.pollInterval : 2000;
        let deadline     = Date.now() + timeout;
        let observed     = null;
        let lastError    = null;

        for (;;) {
            let detail = null;
            let read   = false;
            try {
                detail = await this._actionDetailOf(assemblerActionIndex);
                lastError = null;
                read = true;
            } catch (e) {
                lastError = e;
            }

            if (read && detail) {
                const inspected = inspectDeploymentDetail(this, detail, assemblerActionIndex);
                if (inspected.contractActionIndex !== null) return inspected.contractActionIndex;
                if (inspected.observed) observed = inspected.observed;
            }

            const remaining = deadline - Date.now();
            if (remaining <= 0)
                throw deploymentTimeoutError(assemblerActionIndex, timeout, observed, lastError);
            await new Promise(r => setTimeout(r, Math.min(pollInterval, remaining)));
        }
    },

    // The terminal verdict of a chunk group that settled without a contract. The
    // reported status rides in the message AND on `err.status` so a caller can
    // branch on it without parsing prose.
    _deployedContractFailure(assemblerActionIndex, status) {
        let err = new Error('resolveDeployedContract: DEPLOY ' + assemblerActionIndex
            + ' deployed no contract: ' + status);
        err.status      = status;
        err.actionIndex = assemblerActionIndex;
        return err;
    },

    // The explorer's action detail for one action, unwrapped from whichever
    // envelope it arrives in: the route wraps the row as { data }, the explorer's
    // own getAction answers a single-element array, and some responses nest the
    // row under `action`. Mirrors the unwrap the e2e drills already use.
    async _actionDetailOf(actionIndex) {
        let body = await this.sdk.getAction(actionIndex);
        if (!body) return null;
        let d = (body.data !== undefined && body.data !== null) ? body.data : body;
        if (Array.isArray(d)) d = d.length ? d[0] : null;
        if (!d || typeof d !== 'object') return null;
        if (d.action && typeof d.action === 'object' && !Array.isArray(d.action)
            && d.action.action_index !== undefined) return d.action;
        return d;
    }
};
