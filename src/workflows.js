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

const WalletSession = require('./walletSession.js');
const chunkHelper   = require('./chunkHelper.js');
const Utility       = require('./utility.js');
// Canonical coin registry: the bridge recipes check DEST_COIN and BRIDGE_CHAINS
// against the coins that actually exist rather than against a local list.
const coins         = require('./coins');


class Workflows {

    constructor(sdk) {
        this.sdk = sdk;
    }

    // Issue a token and immediately distribute it to recipients.
    //
    // wif           - WIF private key of the issuer
    // issueParams   - ISSUE action params (tick, maxSupply, decimals, etc.)
    // distributions - [{ destination, amount }, ...]
    // opts          - submit options (waitForIndexer, timeout, etc.)
    //
    // Returns: { issue: <submitResult>, sends: [<submitResult>, ...] }
    async issueAndDistribute(wif, issueParams, distributions, opts = {}) {
        let session = this.sdk.session(wif, opts);
        return this._withPartial({ issue: null, sends: [] }, async (p) => {
            p.issue = await session.issue(issueParams, {}, opts);
            for (let dist of distributions) {
                p.sends.push(await session.send({
                    tick:        issueParams.tick,
                    amount:      dist.amount,
                    destination: dist.destination,
                    memo:        dist.memo
                }, {}, opts));
            }
            return p;
        });
    }

    // Issue a token and immediately mint the initial supply.
    //
    // wif         - WIF private key
    // issueParams - ISSUE action params (tick, maxSupply, etc.)
    // mintParams  - MINT action params (amount, destination; tick is auto-filled)
    // opts        - submit options
    //
    // Returns: { issue: <submitResult>, mint: <submitResult> }
    async issueAndMint(wif, issueParams, mintParams, opts = {}) {
        let session = this.sdk.session(wif, opts);
        return this._withPartial({ issue: null, mint: null }, async (p) => {
            p.issue = await session.issue(issueParams, {}, opts);
            p.mint  = await session.mint({ tick: issueParams.tick, ...mintParams }, {}, opts);
            return p;
        });
    }

    // Create a dispenser: issue token (if needed), then create dispenser.
    //
    // wif             - WIF private key
    // dispenserParams - DISPENSER action params (giveTick, giveAmount, getTick, getAmount, etc.)
    // opts            - submit options
    //
    // Returns: <submitResult>
    async createDispenser(wif, dispenserParams, opts = {}) {
        let session = this.sdk.session(wif, opts);
        return session.dispenser(dispenserParams, {}, opts);
    }

    // Create a limit order on the DEX.
    //
    // wif         - WIF private key
    // orderParams - ORDER action params (giveTick, giveAmount, getTick, getAmount, etc.)
    // opts        - submit options
    //
    // Returns: <submitResult>
    async createOrder(wif, orderParams, opts = {}) {
        let session = this.sdk.session(wif, opts);
        return session.order(orderParams, {}, opts);
    }

    // Cancel an existing order.
    //
    // wif              - WIF private key
    // orderActionIndex - action_index of the order to cancel
    // opts             - submit options
    //
    // Returns: <submitResult>
    async cancelOrder(wif, orderActionIndex, opts = {}) {
        let session = this.sdk.session(wif, opts);
        return session.order({ orderActionIndex }, {}, opts);
    }

    // Stake and optionally delegate a signing key in one flow.
    //
    // wif            - WIF private key
    // stakeParams    - STAKE action params (version, amount, signingPubkey)
    //                  version=1 for a new stake, version=2 to top up an existing pubkey
    // delegateParams - DELEGATE action params (newSigningPubkey); optional, omit to skip
    // opts           - submit options
    //
    // Returns: { stake: <submitResult>, delegate: <submitResult>|null }
    async stakeAndDelegate(wif, stakeParams, delegateParams, opts = {}) {
        let session = this.sdk.session(wif, opts);
        return this._withPartial({ stake: null, delegate: null }, async (p) => {
            p.stake = await session.stake(stakeParams, {}, opts);
            if (delegateParams)
                p.delegate = await session.delegate(delegateParams, {}, opts);
            return p;
        });
    }

    // Stake to a contract and optionally delegate the signing key in one flow.
    //
    // wif            - WIF private key
    // stakeParams    - { AMOUNT, SIGNING_PUBKEY, TARGET_CONTRACT_INDEX, TICK }
    // delegateParams - { SIGNING_PUBKEY, TARGET_CONTRACT_INDEX, TICK } (optional)
    // opts           - submit options
    //
    // Returns: { stake: <submitResult>, delegate: <submitResult>|null }
    async stakeToContractAndDelegate(wif, stakeParams, delegateParams, opts = {}) {
        let session = this.sdk.session(wif, opts);
        return this._withPartial({ stake: null, delegate: null }, async (p) => {
            p.stake = await session.stakeToContract(stakeParams, {}, opts);
            if (delegateParams)
                p.delegate = await session.delegateForContract(delegateParams, {}, opts);
            return p;
        });
    }

    // Deploy a stakeable smart contract. Enforces presence of COOLDOWN_BLOCKS +
    // SLASH_DESTINATION metadata so the resulting contract can accept STAKE v3 actions.
    //
    // wif           - WIF private key
    // deployParams  - DEPLOY action params; MUST include COOLDOWN_BLOCKS (1..100000) and
    //                 SLASH_DESTINATION (address or 'BURN' sentinel). VERSION is forced to 1.
    // deposits      - [{ tick, quantity }, ...] (optional initial token deposits)
    // opts          - submit options, plus opts.preflight (see deployAndFund: the
    //                 contract-identity check runs before anything is composed)
    //
    // Returns: { deploy: <submitResult>, deposits: [<submitResult>, ...] }
    async deployStakeableContract(wif, deployParams, deposits, opts = {}) {
        if (!deployParams || deployParams.COOLDOWN_BLOCKS === undefined || deployParams.COOLDOWN_BLOCKS === null || deployParams.COOLDOWN_BLOCKS === '')
            throw new Error('deployStakeableContract: COOLDOWN_BLOCKS is required');
        if (!deployParams.SLASH_DESTINATION)
            throw new Error('deployStakeableContract: SLASH_DESTINATION is required');
        return this.deployAndFund(wif, Utility.withForcedVersion('1', deployParams), deposits, opts);
    }

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
    }

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
        let session = this.sdk.session(wif, opts);
        let code    = (deployParams.code !== undefined) ? deployParams.code : deployParams.CODE;
        let gasLimit = (deployParams.gasLimit !== undefined) ? deployParams.gasLimit : deployParams.GAS_LIMIT;
        let ctor     = (deployParams.constructorParams !== undefined) ? deployParams.constructorParams : deployParams.CONSTRUCTOR_PARAMS;
        let cooldown = (deployParams.cooldownBlocks !== undefined) ? deployParams.cooldownBlocks : deployParams.COOLDOWN_BLOCKS;
        let slashDst = (deployParams.slashDestination !== undefined) ? deployParams.slashDestination : deployParams.SLASH_DESTINATION;
        let hasStaking = (cooldown !== undefined && cooldown !== null && cooldown !== '');

        // Pre-flight lint the fully-assembled source ONCE, before chunking, so the
        // single-shot and chunked paths share one verdict (default 'block'; pass
        // opts.lint = 'warn' | 'off' to relax). Skipped when the caller pre-encoded.
        if (code !== undefined && code !== null)
            this.sdk._preflightContractLint({ CODE: String(code) }, opts.lint);

        // No raw code (caller pre-encoded) → defer to the normal single-shot deploy.
        // The staking fields go in too: they are what selects DEPLOY v1, and a plan
        // sized on the v0 shape budgets none of that tail, so a stakeable contract
        // landing within those bytes of the cap is planned single-shot and refused
        // by the encoder instead of being chunked.
        let plan = (code !== undefined && code !== null)
            ? chunkHelper.planDeploy(String(code), {
                gasLimit,
                constructorParams: ctor,
                cooldownBlocks:    cooldown,
                slashDestination:  slashDst
            })
            : { single: true };

        // Phase-2 params, built BEFORE Phase 1 so the assembler can be sized while
        // no money has moved. CODE_HASH (no inline code) selects DEPLOY v2; staking → v3.
        let assembleParams = null;
        if (!plan.single) {
            assembleParams = {
                version:           hasStaking ? '3' : '2',
                codeHash:          plan.codeHash,
                gasLimit:          gasLimit,
                constructorParams: (ctor !== undefined) ? ctor : []
            };
            if (hasStaking) {
                assembleParams.cooldownBlocks   = cooldown;
                assembleParams.slashDestination = slashDst;
            }
            this._assertAssemblerFits(assembleParams);
        }

        return this._withPartial({ deploy: null, chunks: [], deposits: [], contractActionIndex: null }, async (p) => {
            if (plan.single) {
                p.deploy = await session.deploy(deployParams, {}, opts);
                // An inline deploy IS the contract's action, so its own indexed row
                // answers the index and there is nothing to resolve.
                p.contractActionIndex = this._actionIndexOf(p.deploy.indexed);
            } else {
                // Phase 1: each ordered base64 slice as its own DEPLOY v4 carrier, confirmed in turn so
                // they are all on-chain (at lower action_index) before the assembling DEPLOY runs.
                for (let i = 0; i < plan.parts.length; i++) {
                    p.chunks.push(await session.deployChunk({
                        codeHash:    plan.codeHash,
                        chunkIndex:  i,
                        totalChunks: plan.totalChunks,
                        codePart:    plan.parts[i]
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
                let assemblerActionIndex = this._actionIndexOf(p.deploy.indexed);
                if (assemblerActionIndex !== undefined && assemblerActionIndex !== null)
                    p.contractActionIndex = await this.resolveDeployedContract(assemblerActionIndex, opts);
            }

            if (deposits && deposits.length > 0) {
                // Same refusal as deployAndFund above: a caller that asked for deposits
                // and got a SUCCESS carrying none was told the contract is funded when
                // it is not. The index comes from the resolution above rather than from
                // indexed.action_index, so a deferred group funds the contract that was
                // actually deployed instead of an assembler that deployed nothing.
                let contractActionIndex = p.contractActionIndex;
                if (contractActionIndex === undefined || contractActionIndex === null)
                    throw new Error('deployContract: DEPLOY action_index unavailable; submit with waitForIndexer enabled');
                for (let dep of deposits) {
                    p.deposits.push(await session.deposit({ contractActionIndex, tick: dep.tick, quantity: dep.quantity }, {}, opts));
                }
            }

            return p;
        });
    }

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
                let hasIndex  = Object.prototype.hasOwnProperty.call(detail, 'deployed_contract_index');
                let hasStatus = Object.prototype.hasOwnProperty.call(detail, 'assembly_status');
                let index     = detail.deployed_contract_index;

                if (hasIndex && index !== undefined && index !== null) return index;

                if (hasIndex || hasStatus) {
                    // The explorer reports the pair. A status that has stopped being
                    // `pending` while no contract index exists means the group settled
                    // without deploying (a hash mismatch or a source drained of gas at
                    // the completing carrier consumes the assembler), and nothing
                    // retries that, so waiting out the timeout would only hide it.
                    let status = detail.assembly_status;
                    if (status !== undefined && status !== null) {
                        observed = String(status);
                        if (!/^pending/i.test(observed))
                            throw this._deployedContractFailure(assemblerActionIndex, observed);
                    }
                } else {
                    // An explorer from before the field landed reports only the
                    // assembler's own status. That is the whole answer for a group
                    // completed by the assembler itself and for one that failed
                    // outright; a pending assembler it cannot resolve, so the poll
                    // runs to the deadline and says which field was missing.
                    let status = (detail.status === undefined || detail.status === null) ? '' : String(detail.status);
                    if (status) observed = status;
                    if (/^valid/i.test(status)) return assemblerActionIndex;
                    if (/^invalid/i.test(status)) throw this._deployedContractFailure(assemblerActionIndex, status);
                }
            }

            let remaining = deadline - Date.now();
            if (remaining <= 0) {
                let err = new Error('resolveDeployedContract: the explorer exposes no deployed_contract_index for DEPLOY '
                    + assemblerActionIndex + ' after ' + timeout + 'ms'
                    + (observed ? ' (last status: ' + observed + ')' : '')
                    + (lastError ? ' (last read error: ' + lastError.message + ')' : ''));
                err.status      = observed;
                err.actionIndex = assemblerActionIndex;
                if (lastError) err.cause = lastError;
                throw err;
            }
            await new Promise(r => setTimeout(r, Math.min(pollInterval, remaining)));
        }
    }

    // The terminal verdict of a chunk group that settled without a contract. The
    // reported status rides in the message AND on `err.status` so a caller can
    // branch on it without parsing prose.
    _deployedContractFailure(assemblerActionIndex, status) {
        let err = new Error('resolveDeployedContract: DEPLOY ' + assemblerActionIndex
            + ' deployed no contract: ' + status);
        err.status      = status;
        err.actionIndex = assemblerActionIndex;
        return err;
    }

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

    // Distribute a dividend to all holders of a token.
    //
    // wif            - WIF private key
    // dividendParams - DIVIDEND action params (tick, dividendTick, amount)
    // opts           - submit options
    //
    // Returns: <submitResult>
    async distributeDividend(wif, dividendParams, opts = {}) {
        let session = this.sdk.session(wif, opts);
        return session.dividend(dividendParams, {}, opts);
    }

    // Issue a unique 1-of-1 NFT, fully minted to the issuer.
    //
    // wif    - issuer WIF
    // params - { tick, description?, transfer?, memo? }
    // Returns: <submitResult>
    async issueNft(wif, params, opts = {}) {
        let session = this.sdk.session(wif, opts);
        return session.issue(this.sdk.nft.unique(params), {}, opts);
    }

    // Issue an edition of N identical, indivisible prints. Pass `mint` to
    // distribute via a public MINT window instead of pre-minting to the issuer.
    //
    // wif    - issuer WIF
    // params - { tick, supply, mint?: { maxMint, perAddress?, startBlock?, stopBlock? },
    //            description?, transfer?, memo? }
    // Returns: <submitResult>
    async issueNftEdition(wif, params, opts = {}) {
        let session = this.sdk.session(wif, opts);
        return session.issue(this.sdk.nft.edition(params), {}, opts);
    }

    // Issue a distinct collection item: a child TICK `parent.name` as a 1-of-1.
    // The issuer must currently own the parent (enforced by the indexer).
    //
    // wif    - issuer WIF
    // params - { parent, name, description?, transfer?, memo? }
    // Returns: <submitResult>
    async issueCollectionItem(wif, params, opts = {}) {
        let session = this.sdk.session(wif, opts);
        return session.issue(this.sdk.nft.collectionItem(params), {}, opts);
    }

    // Attach content to a token: upload a FILE, then LINK it to the token's ISSUE.
    // The LINK is owner-validated by the indexer (SOURCE must own the token).
    //
    // wif    - issuer WIF (must own the token)
    // params - {
    //   coin,                       // chain both actions live on
    //   issueActionIndex,           // ACTION_INDEX of the token's ISSUE
    //   file: { name, type, title?, memo?, rawData },  // FILE upload
    //   memo?,                      // LINK memo
    //   tis?: {                     // OPTIONAL: also author the on-chain TIS
    //     tick,                     //   document (Token_Information_Standard.md
    //     name?, description?       //   On-Chain Format) and point the token's
    //   }                           //   DESCRIPTION at it via ISSUE v1
    // }
    // Requires indexer confirmation (waitForIndexer) so each leg's ACTION_INDEX
    // is resolvable for the next.
    //
    // Returns: { file, link, tisFile?, describe? } (each a <submitResult>)
    async attachContent(wif, params, opts = {}) {
        let session = this.sdk.session(wif, opts);
        return this._withPartial({ file: null, link: null }, async (p) => {
            p.file = await session.file({
                name:  params.file.name,
                type:  params.file.type,
                title: params.file.title,
                memo:  params.file.memo
            }, params.file.rawData !== undefined ? { rawData: params.file.rawData } : {}, opts);

            // The waiter resolves a TRANSACTION object on the polling path and a single-action
            // object on the WS path; _actionIndexOf handles both shapes.
            let fileActionIndex = this._actionIndexOf(p.file.indexed);
            if (fileActionIndex === undefined || fileActionIndex === null)
                throw new Error('attachContent: FILE action_index unavailable; submit with waitForIndexer enabled');

            p.link = await session.link(this.sdk.nft.attachContentParams({
                coin:             params.coin,
                fileActionIndex,
                issueActionIndex: params.issueActionIndex,
                memo:             params.memo
            }), {}, opts);

            if (!params.tis) return p;

            let { json } = this.sdk.nft.tisDocument({
                tick:             params.tis.tick,
                name:             params.tis.name,
                description:      params.tis.description,
                imageActionIndex: fileActionIndex,
                imageType:        params.file.type,
                imageName:        params.file.name
            });
            p.tisFile = await session.file({
                name:  String(params.tis.tick).toUpperCase() + '.json',
                type:  'application/json',
                title: 'Token information'
            }, { rawData: Buffer.from(json, 'utf8').toString('binary') }, opts);
            let tisActionIndex = this._actionIndexOf(p.tisFile.indexed);
            if (tisActionIndex === undefined || tisActionIndex === null)
                throw new Error('attachContent: TIS FILE action_index unavailable; submit with waitForIndexer enabled');

            // ISSUE v1 edits description; owner-only at the indexer.
            p.describe = await session.issue({
                version:     '1',
                tick:        params.tis.tick,
                description: 'action:' + String(tisActionIndex)
            }, {}, opts);

            return p;
        });
    }

    // Publish (or replace) a project's official-token roster: submit a TICK-type
    // LIST, then LINK it to the project's ISSUE. The LINK is owner-validated by
    // the indexer (SOURCE must be the project tick's current owner), and the
    // latest owner-valid roster link supersedes earlier ones. See
    // xchain-documentation/protocol/Project_Registry.md.
    //
    // wif    - project owner WIF
    // params - {
    //   coin,                       // the project's chain (both actions live on it)
    //   issueActionIndex,           // ACTION_INDEX of the project tick's ISSUE
    //   ticks,                      // array of TICK names for a NEW roster, OR
    //   edit: { listActionIndex, add?, remove? },  // derive from an existing roster
    //   memo?                       // LINK memo
    // }
    // Requires indexer confirmation (waitForIndexer) so the LIST's ACTION_INDEX
    // is resolvable for the LINK.
    //
    // Returns: { list: <submitResult>, link: <submitResult> }
    async setRoster(wif, params, opts = {}) {
        let session = this.sdk.session(wif, opts);
        let listParams = params.edit
            ? this.sdk.project.rosterEditParams(params.edit)
            : this.sdk.project.rosterParams({ ticks: params.ticks });
        return this._withPartial({ list: null, link: null }, async (p) => {
            p.list = await session.list(listParams, {}, opts);

            let listActionIndex = this._actionIndexOf(p.list.indexed);
            if (listActionIndex === undefined || listActionIndex === null)
                throw new Error('setRoster: LIST action_index unavailable; submit with waitForIndexer enabled');

            p.link = await session.link(this.sdk.project.attestRosterParams({
                coin:             params.coin,
                listActionIndex,
                issueActionIndex: params.issueActionIndex,
                memo:             params.memo
            }), {}, opts);

            return p;
        });
    }

    // Governance (VOTE) submit recipes: build the VOTE params via sdk.voting.*,
    // then sign + broadcast. `params` matches the corresponding sdk.voting
    // builder. See protocol/actions/VOTE.md.

    // Create a poll (VOTE v0). Returns { result, pollRef }; pollRef is the
    // poll's action_index (needed as pollRef for ballots), available when
    // opts.waitForIndexer is set.
    async createPoll(wif, params, opts = {}) {
        let session = this.sdk.session(wif, opts);
        let result = await session.vote(this.sdk.voting.createPollParams(params), {}, opts);
        return { result, pollRef: this._actionIndexOf(result.indexed) };
    }

    // Cast a ballot against an existing poll (VOTE v1).
    async castBallot(wif, params, opts = {}) {
        let session = this.sdk.session(wif, opts);
        return session.vote(this.sdk.voting.castBallotParams(params), {}, opts);
    }

    // Set a standing per-token vote delegation (VOTE v3).
    async delegateVote(wif, params, opts = {}) {
        let session = this.sdk.session(wif, opts);
        return session.vote(this.sdk.voting.delegateParams(params), {}, opts);
    }

    // Clear a standing per-token vote delegation (VOTE v3, blank DELEGATE_TO).
    async clearVoteDelegation(wif, params, opts = {}) {
        let session = this.sdk.session(wif, opts);
        return session.vote(this.sdk.voting.clearDelegationParams(params), {}, opts);
    }

    // Open a parimutuel betting market (BET v0). Returns the submit result plus
    // the market's action index, which is the FEED_ACTION_INDEX every later bet,
    // resolve, and cancel references. Markets are immutable from creation, so
    // this index is a complete commitment to the market's terms: there is no
    // edit path and nothing about the market can change under a bettor.
    async openMarket(wif, params, opts = {}) {
        let session = this.sdk.session(wif, opts);
        let result  = await session.bet(this.sdk.betting.createMarketParams(params), {}, opts);
        return { result, feedRef: this._actionIndexOf(result.indexed) };
    }

    // Place a bet on an existing market (BET v2). Bets are FINAL once placed:
    // there is no cancel path, by design.
    async placeBet(wif, params, opts = {}) {
        let session = this.sdk.session(wif, opts);
        return session.bet(this.sdk.betting.placeBetParams(params), {}, opts);
    }

    // Resolve a market to its winning outcome (BET v3). Oracle only, and only
    // between the deadline and the end of the refund window.
    async resolveMarket(wif, params, opts = {}) {
        let session = this.sdk.session(wif, opts);
        return session.bet(this.sdk.betting.resolveMarketParams(params), {}, opts);
    }

    // Cancel a market and refund every open bet in full (BET v1). Oracle only,
    // available any time before the market resolves or expires. This is the
    // honest exit for a postponed or voided event.
    async cancelMarket(wif, params, opts = {}) {
        let session = this.sdk.session(wif, opts);
        return session.bet(this.sdk.betting.cancelMarketParams(params), {}, opts);
    }

    // Open a market and immediately place the oracle's own opening context in a
    // single recipe is deliberately NOT offered: the oracle may not bet on its
    // own market (BET.md format 2), so such a helper could only ever produce a
    // rejected second transaction.

    /*
     * Cross-chain bridge recipes (xchain-bridge.md section 13, xchain-token-bridge.md
     * section 9). Every one of them pins its wire VERSION through withForcedVersion:
     * the four user formats differ by ONE field each (v0 vs v3 by TICK, v1 vs v4 by
     * which address they carry), so auto-selection would be deciding which chain the
     * money leaves from, and a caller-supplied version that disagrees throws instead
     * of quietly re-routing.
     *
     * Each also validates its destination address against the COIN and NETWORK it
     * must land on, with the coin-aware validator ported into utility.js. This is the
     * one place the SDK cannot be loose: a lock is one-way, the federation signs what
     * the chain says, and a credit minted to an address nobody holds a key for is
     * gone. The indexer refuses the same address with 'invalid: DEST_ADDRESS', so the
     * check here only ever saves the sender a fee, never widens what the chain takes.
     */

    // Network the bridge helpers validate addresses against. An explicit
    // opts.network wins, then the SDK's configured network, then the environment.
    _bridgeNetwork(opts = {}) {
        return opts.network || (this.sdk.options && this.sdk.options.network) || process.env.NETWORK || null;
    }

    // The Utility instance to validate with. Falls back to a fresh one so the
    // helpers work against the stub sdk their unit tests hand them.
    _bridgeUtil() {
        return (this.sdk && this.sdk.util) ? this.sdk.util : new Utility();
    }

    // Normalize a caller's params to the UPPER_SNAKE wire names once, up front, so
    // these helpers read the same field a composed action would (camelCase in,
    // DEST_ADDRESS out) instead of guessing at the caller's spelling.
    _bridgeParams(params) {
        return this._bridgeUtil().normalizeFields(params || {});
    }

    // Refuse an address that is not valid on the chain the value lands on.
    _assertBridgeAddress(field, address, coin, network) {
        if (!network)
            throw new Error('XBRIDGE ' + field + ' cannot be checked without a network: pass opts.network or construct the SDK with one');
        if (!coin || !coins.ALLOWED_COINS.includes(String(coin).toUpperCase()))
            throw new Error('XBRIDGE ' + field + ' names an unsupported coin: ' + String(coin));
        if (!this._bridgeUtil().isCryptoAddress(address, String(coin).toUpperCase(), network))
            throw new Error('XBRIDGE ' + field + ' "' + String(address) + '" is not a valid ' + String(coin).toUpperCase()
                + ' ' + network + ' address. A bridge credit cannot be recalled, so the lock is refused here.');
    }

    // Lock XCHAIN on BTC for a credit on another chain (XBRIDGE v0, BTC only).
    //
    // wif    - WIF private key of the holder
    // params - { destCoin, destAddress, amount, memo }
    // opts   - submit options (network, waitForIndexer, timeout, ...)
    //
    // Returns: <submitResult>
    async bridgeLock(wif, params, opts = {}) {
        let fields = this._bridgeParams(params);
        this._assertBridgeAddress('DEST_ADDRESS', fields.DEST_ADDRESS, fields.DEST_COIN, this._bridgeNetwork(opts));
        let session = this.sdk.session(wif, opts);
        return session.submit({ action: 'XBRIDGE', params: Utility.withForcedVersion('0', fields) }, {}, opts);
    }

    // Burn bridged XCHAIN off BTC to release the BTC escrow (XBRIDGE v1, never on BTC).
    //
    // params - { btcAddress, amount, memo }
    async bridgeBurn(wif, params, opts = {}) {
        let fields = this._bridgeParams(params);
        this._assertBridgeAddress('BTC_ADDRESS', fields.BTC_ADDRESS, 'BTC', this._bridgeNetwork(opts));
        let session = this.sdk.session(wif, opts);
        return session.submit({ action: 'XBRIDGE', params: Utility.withForcedVersion('1', fields) }, {}, opts);
    }

    // Lock a general token on its origin chain (XBRIDGE v3).
    //
    // params - { tick, destCoin, destAddress, amount, memo }
    //
    // TICK is the NATIVE name on this chain. A rooted name (BTC.FUFU) is the
    // bridged copy and is refused here rather than on chain, because v3 of a
    // bridged row is 'invalid: TICK (not native here)' and the fee is spent either
    // way. The dot rule is the same one the handler applies: milestone 1 bridges no
    // subassets, so any dotted native tick cannot be rooted on the destination.
    async bridgeTokenLock(wif, params, opts = {}) {
        let fields = this._bridgeParams(params);
        let tick   = String(fields.TICK === undefined || fields.TICK === null ? '' : fields.TICK);
        if (!tick)
            throw new Error('XBRIDGE v3 requires a TICK; use bridgeLock() for the gas token');
        if (tick.indexOf('.') !== -1)
            throw new Error('XBRIDGE v3 cannot bridge "' + tick + '": a dotted tick is a subasset or a bridged copy, and neither is bridgeable in this milestone');
        this._assertBridgeAddress('DEST_ADDRESS', fields.DEST_ADDRESS, fields.DEST_COIN, this._bridgeNetwork(opts));
        let session = this.sdk.session(wif, opts);
        return session.submit({ action: 'XBRIDGE', params: Utility.withForcedVersion('3', fields) }, {}, opts);
    }

    // Burn a bridged token row back to its origin chain (XBRIDGE v4).
    //
    // params - { tick, originAddress, amount, memo }
    //
    // The origin chain is the tick's own root (BTC.FUFU burns back to BTC), so
    // ORIGIN_ADDRESS is validated against THAT chain and never against the chain
    // the burn is broadcast on. Reading it from the tick is also what makes a
    // wrong-chain address impossible to express.
    async bridgeTokenBurn(wif, params, opts = {}) {
        let fields = this._bridgeParams(params);
        let parsed = this._bridgeUtil().parseBridgedTick(fields.TICK);
        if (!parsed)
            throw new Error('XBRIDGE v4 needs a bridged tick of the form <ORIGIN>.<NAME>; got "' + String(fields.TICK) + '"');
        this._assertBridgeAddress('ORIGIN_ADDRESS', fields.ORIGIN_ADDRESS, parsed.origin, this._bridgeNetwork(opts));
        let session = this.sdk.session(wif, opts);
        return session.submit({ action: 'XBRIDGE', params: Utility.withForcedVersion('4', fields) }, {}, opts);
    }

    // Set a token's bridgeability (ISSUE format 7). Owner only, no issuance fee.
    //
    // params - { tick, bridgeChains, minDepth, lockBridge, memo }
    //
    // bridgeChains is a comma list of destination coins, or the '-' sentinel for
    // none. An EMPTY field means UNCHANGED on chain, so an empty string is refused
    // here: a caller who means "close every door" must say '-', and a caller who
    // means "leave it alone" must omit the field.
    async setTokenBridgeability(wif, params, opts = {}) {
        let fields = this._bridgeParams(params);
        if (fields.BRIDGE_CHAINS !== undefined && fields.BRIDGE_CHAINS !== null && String(fields.BRIDGE_CHAINS) !== '-') {
            let chains = String(fields.BRIDGE_CHAINS).split(',').map(c => c.trim());
            if (!chains.length || chains.some(c => !c))
                throw new Error('ISSUE v7 BRIDGE_CHAINS must be a comma list of coins or the "-" sentinel; got "' + String(fields.BRIDGE_CHAINS) + '"');
            let allowed = coins.ALLOWED_COINS;
            for (let chain of chains)
                if (!allowed.includes(chain.toUpperCase()))
                    throw new Error('ISSUE v7 BRIDGE_CHAINS names an unsupported coin: ' + chain);
            fields.BRIDGE_CHAINS = chains.map(c => c.toUpperCase()).join(',');
        }
        let session = this.sdk.session(wif, opts);
        return session.submit({ action: 'ISSUE', params: Utility.withForcedVersion('7', fields) }, {}, opts);
    }

    // Throw unless the chunked deploy's Phase-2 assembler fits the compiled-action
    // cap. planDeploy sizes only the INLINE DEPLOY, so an oversized constructor
    // param (or staking field) survives planning and first surfaces at Phase 2,
    // after every paid v4 carrier is already broadcast and confirmed: the money is
    // gone and the contract can never assemble. Compose through the canonical
    // action-string core so the measurement cannot drift from what would actually
    // go on the wire, and gate on the same compiled-push quantity fitsSingleDeploy
    // uses (payload + OP_PUSHDATA2 prefix, exact in the 8192-byte neighbourhood).
    _assertAssemblerFits(assembleParams) {
        let composed  = this.sdk.actions.composeActionString({ action: 'DEPLOY', params: Object.assign({}, assembleParams) });
        let compiled  = Buffer.byteLength(composed.actionString, 'utf8') + chunkHelper.OP_RETURN_PUSH_OVERHEAD;
        if (compiled > chunkHelper.MAX_ACTION_DATA_LENGTH)
            throw new Error('Chunked deploy assembling DEPLOY v' + composed.version + ' compiles to ' + compiled
                + ' bytes, exceeds MAX_ACTION_DATA_LENGTH (' + chunkHelper.MAX_ACTION_DATA_LENGTH
                + '). Shrink constructorParams. No carrier actions were broadcast.');
    }

    // Run a multi-step recipe whose steps broadcast independent, NON-atomic
    // transactions. `partial` is a mutable accumulator the worker fills in as each
    // step completes; on any throw (including a later step or a missing action_index),
    // the results already broadcast are attached to the error as `err.partial` so the
    // caller can reconcile instead of losing their txids. On success the worker's
    // return value (normally `partial` itself) is returned unchanged.
    async _withPartial(partial, worker) {
        try {
            return await worker(partial);
        } catch (err) {
            if (err && typeof err === 'object' && err.partial === undefined) {
                try { err.partial = partial; } catch (e) { /* frozen/exotic error: leave it */ }
            }
            throw err;
        }
    }

    // Extract an action_index from a submitAction `indexed` result, tolerating both
    // shapes the waiter can resolve: a transaction ({ actions: [{ action_index }] })
    // on the polling path, or a single action ({ action_index }) on the WS path.
    _actionIndexOf(indexed) {
        if (!indexed) return undefined;
        if (indexed.action_index !== undefined && indexed.action_index !== null) return indexed.action_index;
        if (Array.isArray(indexed.actions) && indexed.actions.length) return indexed.actions[0].action_index;
        return undefined;
    }

}

module.exports = Workflows;
