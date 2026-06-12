/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Platform SDK - NFT Helpers
 *
 * Non-fungible tokens on XChain are a composition of existing
 * primitives, not a special token type (see
 * xchain-documentation/protocol/NFT_Standard.md). There is no NFT
 * action, flag, or wire format — an "NFT" is an ISSUE with DECIMALS=0
 * and LOCK_MAX_SUPPLY=1. These helpers are the guided builders that
 * encode that rule in one place so every client mints NFTs correctly,
 * plus the canonical classification predicate and the content-attach
 * (LINK) param builder. All pure — no network, no consensus.
 *
 ********************************************************************/

class NftHelpers {

    // Build ISSUE params for a unique 1-of-1, fully minted to the issuer.
    //
    // tick        - ticker name
    // description - (optional) DESCRIPTION (icon URL / TIS JSON pointer)
    // transfer    - (optional) address to transfer issuer ownership to
    // memo        - (optional)
    //
    // Returns an ISSUE param object (camelCase; the SDK normalizes to UPPER_SNAKE).
    unique({ tick, description, transfer, memo } = {}) {
        if (!tick) throw new Error('nft.unique: tick is required');
        return this._issue({ tick, maxSupply: '1', mintSupply: '1', description, transfer, memo });
    }

    // Build ISSUE params for an edition of N identical, indivisible prints.
    //
    // tick    - ticker name
    // supply  - edition size N (MAX_SUPPLY)
    // mint    - (optional) fair-mint config; when present the edition distributes
    //           through a public MINT window instead of being pre-minted:
    //             { maxMint, perAddress?, startBlock?, stopBlock? }
    //           No print is self-minted: LOCK_MAX_SUPPLY validates the declared
    //           cap (not minted supply), so the cap locks at issuance with zero
    //           supply and the whole edition stays publicly mintable.
    // description, transfer, memo - (optional)
    edition({ tick, supply, mint, description, transfer, memo } = {}) {
        if (!tick) throw new Error('nft.edition: tick is required');
        if (supply === undefined || supply === null || String(supply) === '')
            throw new Error('nft.edition: supply (maxSupply) is required');
        let params = this._issue({ tick, maxSupply: String(supply), description, transfer, memo });
        if (mint) {
            // Fair-mint edition: open a public MINT window. The cap locks at issuance
            // with zero minted supply (LOCK_MAX_SUPPLY now validates a declared cap, not
            // minted supply), so the whole edition stays available for the public mint —
            // no print is forced onto the issuer.
            params.maxMint        = String(mint.maxMint);
            if (mint.perAddress !== undefined) params.mintAddressMax  = String(mint.perAddress);
            if (mint.startBlock !== undefined) params.mintStartBlock  = String(mint.startBlock);
            if (mint.stopBlock  !== undefined) params.mintStopBlock   = String(mint.stopBlock);
        } else {
            // Pre-minted edition: mint the whole supply to the issuer up front.
            params.mintSupply = String(supply);
        }
        return params;
    }

    // Build ISSUE params for a distinct item in a collection — a child TICK
    // `parent.name`, issued as a unique 1-of-1. The SOURCE must own the parent
    // (enforced by the indexer); this only builds the params.
    //
    // parent - the collection's parent TICK
    // name   - the item's child segment (must not contain '.')
    collectionItem({ parent, name, description, transfer, memo } = {}) {
        if (!parent) throw new Error('nft.collectionItem: parent is required');
        if (!name)   throw new Error('nft.collectionItem: name is required');
        if (String(name).includes('.'))
            throw new Error("nft.collectionItem: name must not contain '.' (it is the child segment only)");
        return this.unique({ tick: `${parent}.${name}`, description, transfer, memo });
    }

    // Build LINK params to officially attach a FILE to a token (the NFT
    // content-attachment pattern). The LINK SOURCE must own the token; the
    // indexer validates ownership. Both action indices are required.
    //
    // coin             - the chain both actions live on (BTC/LTC/DOGE)
    // fileActionIndex  - ACTION_INDEX of the FILE upload
    // issueActionIndex - ACTION_INDEX of the token's ISSUE
    // (or pass fileCoin/issueCoin explicitly for a cross-chain attachment)
    attachContentParams({ coin, fileActionIndex, issueActionIndex, fileCoin, issueCoin, memo } = {}) {
        let c1 = fileCoin  || coin;
        let c2 = issueCoin || coin;
        if (!c1 || !c2) throw new Error('nft.attachContentParams: coin (or fileCoin/issueCoin) is required');
        if (fileActionIndex === undefined || issueActionIndex === undefined)
            throw new Error('nft.attachContentParams: fileActionIndex and issueActionIndex are required');
        return {
            coin1:            c1,
            coin1ActionIndex: String(fileActionIndex),
            coin2:            c2,
            coin2ActionIndex: String(issueActionIndex),
            memo
        };
    }

    // Build a minimal TIS v1.0.0 document for an NFT-pattern token
    // (Token_Information_Standard.md). Intended for the fully on-chain
    // authoring path: upload the returned JSON as a FILE action
    // (TYPE application/json) and set the token's DESCRIPTION to
    // "action:<index>" of that upload (the On-Chain Format).
    //
    // tick             - the token's TICK (required)
    // name             - display name (optional)
    // description      - prose description (optional)
    // imageActionIndex - on-chain artwork FILE to reference via data_ref (optional)
    // imageCoin        - base coin ticker (BTC/LTC/DOGE) when the artwork FILE
    //                    lives on a SIBLING chain (optional; omitted = same
    //                    chain as the token — network tier is implied)
    // imageUrl         - off-chain artwork URL (optional; data_ref preferred when both)
    // imageType        - artwork MIME type (optional)
    // imageName        - artwork filename (optional)
    //
    // Returns { doc, json } — the document object and its serialized form.
    tisDocument({ tick, name, description, imageActionIndex, imageCoin, imageUrl, imageType, imageName } = {}) {
        if (!tick) throw new Error('nft.tisDocument: tick is required');
        let doc = {
            tick: String(tick).toUpperCase(),
            // Declare collectible intent so clients distinguish an NFT from a
            // currency that shares the same field values (TIS — NFT Usage).
            categories: [{ type: 'main', data: 'NFT' }]
        };
        if (name)        doc.name        = String(name);
        if (description) doc.description = String(description);
        if (imageActionIndex !== undefined && imageActionIndex !== null || imageUrl) {
            let entry = {};
            if (imageActionIndex !== undefined && imageActionIndex !== null)
                entry.data_ref = 'action:' + (imageCoin ? String(imageCoin).toUpperCase() + ':' : '') + String(imageActionIndex);
            if (imageUrl)  entry.data = String(imageUrl);
            if (imageType) entry.type = String(imageType);
            if (imageName) entry.name = String(imageName);
            doc.images = [entry];
        }
        return { doc, json: JSON.stringify(doc) };
    }

    // Canonical NFT classification (NFT_Standard.md): a token follows the NFT
    // pattern when it is indivisible (DECIMALS=0) and permanently supply-capped
    // (LOCK_MAX_SUPPLY=1). Accepts a token-info object using either UPPER_SNAKE
    // (explorer/indexer shape) or camelCase keys.
    isNft(token) {
        if (!token) return false;
        // Accept UPPER_SNAKE (indexer), lower snake_case (explorer JSON column names),
        // and camelCase (SDK param) shapes — the explorer returns `lock_max_supply`.
        let decimals = token.DECIMALS        ?? token.decimals;
        let locked   = token.LOCK_MAX_SUPPLY ?? token.lock_max_supply ?? token.lockMaxSupply;
        return Number(decimals) === 0 && Number(locked) === 1;
    }

    // Shared ISSUE skeleton enforcing the NFT field bundle: DECIMALS=0 +
    // LOCK_MAX_SUPPLY=1. Drops undefined optionals so the SDK's trailing-field
    // stripping keeps the serialization compact.
    _issue({ tick, maxSupply, mintSupply, description, transfer, memo }) {
        let params = {
            tick,
            maxSupply:      String(maxSupply),
            decimals:       '0',
            lockMaxSupply:  '1',
        };
        if (mintSupply  !== undefined) params.mintSupply  = String(mintSupply);
        if (description  !== undefined && description !== null) params.description = description;
        if (transfer     !== undefined && transfer    !== null) params.transfer    = transfer;
        if (memo         !== undefined && memo        !== null) params.memo        = memo;
        return params;
    }
}

module.exports = NftHelpers;
