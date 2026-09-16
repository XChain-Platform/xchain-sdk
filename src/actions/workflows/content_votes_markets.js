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



module.exports = {
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
    },

    // Issue a unique 1-of-1 NFT, fully minted to the issuer.
    //
    // wif    - issuer WIF
    // params - { tick, description?, transfer?, memo? }
    // Returns: <submitResult>
    async issueNft(wif, params, opts = {}) {
        let session = this.sdk.session(wif, opts);
        return session.issue(this.sdk.nft.unique(params), {}, opts);
    },

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
    },

    // Issue a distinct collection item: a child TICK `parent.name` as a 1-of-1.
    // The issuer must currently own the parent (enforced by the indexer).
    //
    // wif    - issuer WIF
    // params - { parent, name, description?, transfer?, memo? }
    // Returns: <submitResult>
    async issueCollectionItem(wif, params, opts = {}) {
        let session = this.sdk.session(wif, opts);
        return session.issue(this.sdk.nft.collectionItem(params), {}, opts);
    },

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
        return this.withPartial({ file: null, link: null }, async (p) => {
            p.file = await session.file({
                name:  params.file.name,
                type:  params.file.type,
                title: params.file.title,
                memo:  params.file.memo
            }, params.file.rawData !== undefined ? { rawData: params.file.rawData } : {}, opts);

            // The waiter resolves a TRANSACTION object on the polling path and a single-action
            // object on the WS path; actionIndexOf handles both shapes.
            let fileActionIndex = this.actionIndexOf(p.file.indexed);
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
            let tisActionIndex = this.actionIndexOf(p.tisFile.indexed);
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
    },

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
        return this.withPartial({ list: null, link: null }, async (p) => {
            p.list = await session.list(listParams, {}, opts);

            let listActionIndex = this.actionIndexOf(p.list.indexed);
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
    },

    // Governance (VOTE) submit recipes: build the VOTE params via sdk.voting.*,
    // then sign + broadcast. `params` matches the corresponding sdk.voting
    // builder. See protocol/actions/VOTE.md.

    // Create a poll (VOTE v0). Returns { result, pollRef }; pollRef is the
    // poll's action_index (needed as pollRef for ballots), available when
    // opts.waitForIndexer is set.
    async createPoll(wif, params, opts = {}) {
        let session = this.sdk.session(wif, opts);
        let result = await session.vote(this.sdk.voting.createPollParams(params), {}, opts);
        return { result, pollRef: this.actionIndexOf(result.indexed) };
    },

    // Cast a ballot against an existing poll (VOTE v1).
    async castBallot(wif, params, opts = {}) {
        let session = this.sdk.session(wif, opts);
        return session.vote(this.sdk.voting.castBallotParams(params), {}, opts);
    },

    // Set a standing per-token vote delegation (VOTE v3).
    async delegateVote(wif, params, opts = {}) {
        let session = this.sdk.session(wif, opts);
        return session.vote(this.sdk.voting.delegateParams(params), {}, opts);
    },

    // Clear a standing per-token vote delegation (VOTE v3, blank DELEGATE_TO).
    async clearVoteDelegation(wif, params, opts = {}) {
        let session = this.sdk.session(wif, opts);
        return session.vote(this.sdk.voting.clearDelegationParams(params), {}, opts);
    },

    // Open a parimutuel betting market (BET v0). Returns the submit result plus
    // the market's action index, which is the FEED_ACTION_INDEX every later bet,
    // resolve, and cancel references. Markets are immutable from creation, so
    // this index is a complete commitment to the market's terms: there is no
    // edit path and nothing about the market can change under a bettor.
    async openMarket(wif, params, opts = {}) {
        let session = this.sdk.session(wif, opts);
        let result  = await session.bet(this.sdk.betting.createMarketParams(params), {}, opts);
        return { result, feedRef: this.actionIndexOf(result.indexed) };
    },

    // Place a bet on an existing market (BET v2). Bets are FINAL once placed:
    // there is no cancel path, by design.
    async placeBet(wif, params, opts = {}) {
        let session = this.sdk.session(wif, opts);
        return session.bet(this.sdk.betting.placeBetParams(params), {}, opts);
    },

    // Resolve a market to its winning outcome (BET v3). Oracle only, and only
    // between the deadline and the end of the refund window.
    async resolveMarket(wif, params, opts = {}) {
        let session = this.sdk.session(wif, opts);
        return session.bet(this.sdk.betting.resolveMarketParams(params), {}, opts);
    },

    // Cancel a market and refund every open bet in full (BET v1). Oracle only,
    // available any time before the market resolves or expires. This is the
    // honest exit for a postponed or voided event.
    async cancelMarket(wif, params, opts = {}) {
        let session = this.sdk.session(wif, opts);
        return session.bet(this.sdk.betting.cancelMarketParams(params), {}, opts);
    }
};
