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

        // Step 1: Issue the token
        let issueResult = await session.issue(issueParams, {}, opts);

        // Step 2: Send to each recipient
        let sends = [];
        for (let dist of distributions) {
            let sendResult = await session.send({
                tick:        issueParams.tick,
                amount:      dist.amount,
                destination: dist.destination,
                memo:        dist.memo
            }, {}, opts);
            sends.push(sendResult);
        }

        return { issue: issueResult, sends };
    }

    // Issue a token and immediately mint the initial supply.
    //
    // wif         - WIF private key
    // issueParams - ISSUE action params (tick, maxSupply, etc.)
    // mintParams  - MINT action params (amount, destination — tick is auto-filled)
    // opts        - submit options
    //
    // Returns: { issue: <submitResult>, mint: <submitResult> }
    async issueAndMint(wif, issueParams, mintParams, opts = {}) {
        let session = this.sdk.session(wif, opts);

        let issueResult = await session.issue(issueParams, {}, opts);
        let mintResult  = await session.mint({
            tick: issueParams.tick,
            ...mintParams
        }, {}, opts);

        return { issue: issueResult, mint: mintResult };
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
    // delegateParams - DELEGATE action params (newSigningPubkey) — optional, omit to skip
    // opts           - submit options
    //
    // Returns: { stake: <submitResult>, delegate: <submitResult>|null }
    async stakeAndDelegate(wif, stakeParams, delegateParams, opts = {}) {
        let session = this.sdk.session(wif, opts);

        let stakeResult = await session.stake(stakeParams, {}, opts);
        let delegateResult = null;

        if (delegateParams) {
            delegateResult = await session.delegate(delegateParams, {}, opts);
        }

        return { stake: stakeResult, delegate: delegateResult };
    }

    // Stake to a contract and optionally delegate the signing key in one flow.
    //
    // wif            - WIF private key
    // stakeParams    - { AMOUNT, SIGNING_PUBKEY, TARGET_CONTRACT_INDEX, TICK }
    // delegateParams - { SIGNING_PUBKEY, TARGET_CONTRACT_INDEX, TICK } — optional
    // opts           - submit options
    //
    // Returns: { stake: <submitResult>, delegate: <submitResult>|null }
    async stakeToContractAndDelegate(wif, stakeParams, delegateParams, opts = {}) {
        let session = this.sdk.session(wif, opts);
        let stakeResult = await session.stakeToContract(stakeParams, {}, opts);
        let delegateResult = null;
        if (delegateParams) {
            delegateResult = await session.delegateForContract(delegateParams, {}, opts);
        }
        return { stake: stakeResult, delegate: delegateResult };
    }

    // Deploy a stakeable smart contract — enforces presence of COOLDOWN_BLOCKS + SLASH_DESTINATION
    // metadata so the resulting contract can accept STAKE v3 actions.
    //
    // wif           - WIF private key
    // deployParams  - DEPLOY action params; MUST include COOLDOWN_BLOCKS (1..100000) and
    //                 SLASH_DESTINATION (address or 'BURN' sentinel). VERSION is forced to 1.
    // deposits      - [{ tick, quantity }, ...] — optional initial token deposits
    // opts          - submit options
    //
    // Returns: { deploy: <submitResult>, deposits: [<submitResult>, ...] }
    async deployStakeableContract(wif, deployParams, deposits, opts = {}) {
        if (!deployParams || deployParams.COOLDOWN_BLOCKS === undefined || deployParams.COOLDOWN_BLOCKS === null || deployParams.COOLDOWN_BLOCKS === '')
            throw new Error('deployStakeableContract: COOLDOWN_BLOCKS is required');
        if (!deployParams.SLASH_DESTINATION)
            throw new Error('deployStakeableContract: SLASH_DESTINATION is required');
        return this.deployAndFund(wif, { VERSION: '1', ...deployParams }, deposits, opts);
    }

    // Deploy a smart contract and optionally deposit initial tokens.
    //
    // wif           - WIF private key
    // deployParams  - DEPLOY action params (code/codeEncoding, gasLimit, constructorParams)
    // deposits      - [{ tick, quantity }, ...] — optional initial token deposits
    // opts          - submit options
    //
    // Returns: { deploy: <submitResult>, deposits: [<submitResult>, ...] }
    async deployAndFund(wif, deployParams, deposits, opts = {}) {
        let session = this.sdk.session(wif, opts);

        let deployResult = await session.deploy(deployParams, {}, opts);

        let depositResults = [];
        if (deposits && deposits.length > 0) {
            // Use the action_index from the deploy result for the contract reference
            let contractActionIndex = deployResult.indexed
                ? deployResult.indexed.action_index
                : null;

            if (contractActionIndex !== null) {
                for (let dep of deposits) {
                    let result = await session.deposit({
                        contractActionIndex,
                        tick:     dep.tick,
                        quantity: dep.quantity
                    }, {}, opts);
                    depositResults.push(result);
                }
            }
        }

        return { deploy: deployResult, deposits: depositResults };
    }

    // Deploy a smart contract, AUTO-SELECTING single-shot vs chunked, then optionally
    // deposit initial tokens. If base64(code) fits one DEPLOY action it deploys inline
    // (DEPLOY v0/v1); otherwise it submits each base64 slice as a DEPLOY v4 carrier (awaiting
    // indexer confirmation per chunk) then an assembling DEPLOY v2/v3 carrying the
    // CODE_HASH. Pass raw `code` (not codeEncoding/codeHash) so the planner can size it.
    //
    // wif           - WIF private key
    // deployParams  - { code, gasLimit, constructorParams, [cooldownBlocks, slashDestination] }
    // deposits      - [{ tick, quantity }, ...] — optional initial token deposits
    // opts          - submit options
    //
    // Returns: { deploy: <submitResult>, chunks: [<submitResult>...], deposits: [...] }
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
        let plan = (code !== undefined && code !== null)
            ? chunkHelper.planDeploy(String(code), { gasLimit, constructorParams: ctor })
            : { single: true };

        let chunkResults = [];
        let deployResult;
        if (plan.single) {
            deployResult = await session.deploy(deployParams, {}, opts);
        } else {
            // Phase 1: each ordered base64 slice as its own DEPLOY v4 carrier, confirmed in turn so
            // they are all on-chain (at lower action_index) before the assembling DEPLOY runs.
            for (let i = 0; i < plan.parts.length; i++) {
                let r = await session.deployChunk({
                    codeHash:    plan.codeHash,
                    chunkIndex:  i,
                    totalChunks: plan.totalChunks,
                    codePart:    plan.parts[i]
                }, {}, opts);
                chunkResults.push(r);
            }
            // Phase 2: assemble. CODE_HASH (no inline code) selects DEPLOY v2; staking → v3.
            let assembleParams = {
                version:           hasStaking ? '3' : '2',
                codeHash:          plan.codeHash,
                gasLimit:          gasLimit,
                constructorParams: (ctor !== undefined) ? ctor : []
            };
            if (hasStaking) {
                assembleParams.cooldownBlocks   = cooldown;
                assembleParams.slashDestination = slashDst;
            }
            deployResult = await session.deploy(assembleParams, {}, opts);
        }

        let depositResults = [];
        if (deposits && deposits.length > 0) {
            let contractActionIndex = deployResult.indexed ? deployResult.indexed.action_index : null;
            if (contractActionIndex !== null) {
                for (let dep of deposits) {
                    let result = await session.deposit({ contractActionIndex, tick: dep.tick, quantity: dep.quantity }, {}, opts);
                    depositResults.push(result);
                }
            }
        }

        return { deploy: deployResult, chunks: chunkResults, deposits: depositResults };
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

    // ── NFT recipes ─────────────────────────────────────────────────────────
    // Thin submit-flows over the NFT pattern (ISSUE with DECIMALS=0 +
    // LOCK_MAX_SUPPLY=1). The field bundle is built by sdk.nft.* so the rule
    // lives in one place. Spec: protocol/NFT_Standard.md.

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

    // Issue a distinct collection item — a child TICK `parent.name` as a 1-of-1.
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
    //   tis?: {                     // OPTIONAL — also author the on-chain TIS
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

        // Step 1: upload the FILE
        let fileResult = await session.file({
            name:  params.file.name,
            type:  params.file.type,
            title: params.file.title,
            memo:  params.file.memo
        }, params.file.rawData !== undefined ? { rawData: params.file.rawData } : {}, opts);

        // Resolve the FILE's action_index from the indexed result. The waiter resolves
        // a TRANSACTION object ({ tx_hash, actions: [...] }) on the polling path and a
        // single-action object on the WS path, so check both shapes.
        let fileActionIndex = this._actionIndexOf(fileResult.indexed);
        if (fileActionIndex === undefined || fileActionIndex === null)
            throw new Error('attachContent: FILE action_index unavailable — submit with waitForIndexer enabled');

        // Step 2: LINK the FILE to the token's ISSUE (owner-validated by the indexer)
        let linkResult = await session.link(this.sdk.nft.attachContentParams({
            coin:             params.coin,
            fileActionIndex,
            issueActionIndex: params.issueActionIndex,
            memo:             params.memo
        }), {}, opts);

        let out = { file: fileResult, link: linkResult };
        if (!params.tis) return out;

        // Step 3 (optional): author the TIS document on-chain — a JSON FILE
        // whose images[] data_ref points at the artwork upload from step 1.
        let { json } = this.sdk.nft.tisDocument({
            tick:             params.tis.tick,
            name:             params.tis.name,
            description:      params.tis.description,
            imageActionIndex: fileActionIndex,
            imageType:        params.file.type,
            imageName:        params.file.name
        });
        let tisFileResult = await session.file({
            name:  String(params.tis.tick).toUpperCase() + '.json',
            type:  'application/json',
            title: 'Token information'
        }, { rawData: Buffer.from(json, 'utf8').toString('binary') }, opts);
        let tisActionIndex = this._actionIndexOf(tisFileResult.indexed);
        if (tisActionIndex === undefined || tisActionIndex === null)
            throw new Error('attachContent: TIS FILE action_index unavailable — submit with waitForIndexer enabled');

        // Step 4: point the token's DESCRIPTION at the on-chain document
        // (ISSUE v1 — edit description; owner-only at the indexer).
        let describeResult = await session.issue({
            version:     '1',
            tick:        params.tis.tick,
            description: 'action:' + String(tisActionIndex)
        }, {}, opts);

        out.tisFile  = tisFileResult;
        out.describe = describeResult;
        return out;
    }

    // Publish (or replace) a project's official-token roster: submit a TICK-type
    // LIST, then LINK it to the project's ISSUE. The LINK is owner-validated by
    // the indexer (SOURCE must be the project tick's current owner), and the
    // latest owner-valid roster link supersedes earlier ones — see
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

        // Step 1: publish the roster LIST (new, or derived from an existing one)
        let listParams = params.edit
            ? this.sdk.project.rosterEditParams(params.edit)
            : this.sdk.project.rosterParams({ ticks: params.ticks });
        let listResult = await session.list(listParams, {}, opts);

        let listActionIndex = this._actionIndexOf(listResult.indexed);
        if (listActionIndex === undefined || listActionIndex === null)
            throw new Error('setRoster: LIST action_index unavailable — submit with waitForIndexer enabled');

        // Step 2: LINK the roster to the project's ISSUE (owner-validated)
        let linkResult = await session.link(this.sdk.project.attestRosterParams({
            coin:             params.coin,
            listActionIndex,
            issueActionIndex: params.issueActionIndex,
            memo:             params.memo
        }), {}, opts);

        return { list: listResult, link: linkResult };
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
