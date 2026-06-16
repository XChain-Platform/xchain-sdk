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
 * XChain Platform SDK - NftHelpers Tests
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const NftHelpers = require('../../src/nft.js');
const { XChainSDK } = require('../../index.js');

// Parse an ISSUE v0 action string into a field map keyed by the documented template,
// so assertions reference field names rather than fragile positional indices.
const ISSUE_V0 = ('ACTION|VERSION|TICK|MAX_SUPPLY|MAX_MINT|DECIMALS|DESCRIPTION|MINT_SUPPLY|' +
    'TRANSFER|TRANSFER_SUPPLY|LOCK_MAX_SUPPLY|LOCK_MAX_MINT|LOCK_DESCRIPTION|LOCK_SLEEP|' +
    'LOCK_CALLBACK|CALLBACK_BLOCK|CALLBACK_TICK|CALLBACK_AMOUNT|ALLOW_LIST|BLOCK_LIST|' +
    'MINT_ADDRESS_MAX|MINT_START_BLOCK|MINT_STOP_BLOCK|LOCK_MINT|LOCK_MINT_SUPPLY|MEMO').split('|');

function parseIssue(str) {
    let parts = str.split('|');
    let out = {};
    ISSUE_V0.forEach((name, i) => { out[name] = parts[i]; });
    return out;
}

describe('NftHelpers', function () {

    let nft, sdk;
    beforeEach(function () {
        nft = new NftHelpers();
        sdk = new XChainSDK({ network: 'bitcoin-regtest' });
    });

    describe('unique()', function () {
        it('builds the NFT field bundle: DECIMALS=0, LOCK_MAX_SUPPLY=1, supply 1, minted 1', function () {
            const p = nft.unique({ tick: 'PEPECREATURE' });
            expect(p).to.include({ tick: 'PEPECREATURE', maxSupply: '1', decimals: '0', lockMaxSupply: '1', mintSupply: '1' });
        });
        it('serializes to a valid ISSUE with DECIMALS=0 and LOCK_MAX_SUPPLY=1', function () {
            const r = sdk.actions.createAction({ action: 'ISSUE', params: nft.unique({ tick: 'PEPECREATURE' }) });
            const f = parseIssue(r.actionString);
            expect(f.ACTION).to.equal('ISSUE');
            expect(f.TICK).to.equal('PEPECREATURE');
            expect(f.MAX_SUPPLY).to.equal('1');
            expect(f.DECIMALS).to.equal('0');
            expect(f.LOCK_MAX_SUPPLY).to.equal('1');
            expect(sdk.actions.validateAction('ISSUE', nft.unique({ tick: 'PEPECREATURE' })).valid).to.equal(true);
        });
        it('passes through description and transfer', function () {
            const p = nft.unique({ tick: 'X', description: 'ipfs:abc', transfer: 'mTransferAddr' });
            expect(p.description).to.equal('ipfs:abc');
            expect(p.transfer).to.equal('mTransferAddr');
        });
        it('requires tick', function () {
            expect(() => nft.unique({})).to.throw(/tick is required/);
        });
    });

    describe('edition()', function () {
        it('pre-mints the whole supply to the issuer when no mint config', function () {
            const p = nft.edition({ tick: 'PRINT', supply: 100 });
            expect(p).to.include({ tick: 'PRINT', maxSupply: '100', decimals: '0', lockMaxSupply: '1', mintSupply: '100' });
            expect(p.maxMint).to.equal(undefined);
        });
        it('builds a fair-mint window with NO self-mint — the cap locks at zero supply', function () {
            const p = nft.edition({ tick: 'PRINT', supply: 100, mint: { maxMint: 1, perAddress: 1, startBlock: 10, stopBlock: 20 } });
            expect(p).to.include({
                maxSupply: '100', decimals: '0', lockMaxSupply: '1',
                maxMint: '1', mintAddressMax: '1', mintStartBlock: '10', mintStopBlock: '20'
            });
            // LOCK_MAX_SUPPLY validates the declared cap (not minted supply), so no
            // print is forced onto the issuer — the whole edition stays publicly mintable.
            expect(p.mintSupply).to.equal(undefined);
        });
        it('fair-mint edition serializes to a valid ISSUE that locks the cap with zero minted supply', function () {
            const r = sdk.actions.createAction({ action: 'ISSUE', params: nft.edition({ tick: 'PRINT', supply: 100, mint: { maxMint: 1 } }) });
            const f = parseIssue(r.actionString);
            expect(f.MAX_SUPPLY).to.equal('100');
            expect(f.DECIMALS).to.equal('0');
            expect(f.MINT_SUPPLY).to.equal('');      // no self-mint — the cap locks against the declared MAX_SUPPLY
            expect(f.LOCK_MAX_SUPPLY).to.equal('1');
        });
        it('requires tick and supply', function () {
            expect(() => nft.edition({ supply: 5 })).to.throw(/tick is required/);
            expect(() => nft.edition({ tick: 'X' })).to.throw(/supply .* is required/);
        });
    });

    describe('collectionItem()', function () {
        it('builds a child TICK parent.name as a unique 1-of-1', function () {
            const p = nft.collectionItem({ parent: 'PEPESERIES', name: 'GENESIS' });
            expect(p.tick).to.equal('PEPESERIES.GENESIS');
            expect(p).to.include({ maxSupply: '1', decimals: '0', lockMaxSupply: '1' });
        });
        it("rejects a name containing '.' (caller passes the child segment only)", function () {
            expect(() => nft.collectionItem({ parent: 'A', name: 'B.C' })).to.throw(/must not contain/);
        });
        it('requires parent and name', function () {
            expect(() => nft.collectionItem({ name: 'X' })).to.throw(/parent is required/);
            expect(() => nft.collectionItem({ parent: 'X' })).to.throw(/name is required/);
        });
    });

    describe('tisDocument()', function () {
        it('builds a minimal NFT-intent doc with an on-chain data_ref', function () {
            const { doc, json } = nft.tisDocument({
                tick: 'art1', name: 'Art One', description: 'First print',
                imageActionIndex: 1234, imageType: 'image/png', imageName: 'art.png',
            });
            expect(doc.tick).to.equal('ART1');
            expect(doc.name).to.equal('Art One');
            expect(doc.categories).to.deep.equal([{ type: 'main', data: 'NFT' }]);
            expect(doc.images).to.deep.equal([{
                data_ref: 'action:1234', type: 'image/png', name: 'art.png',
            }]);
            expect(JSON.parse(json)).to.deep.equal(doc);
        });
        it('supports an off-chain image URL and omits empty fields', function () {
            const { doc } = nft.tisDocument({ tick: 'X', imageUrl: 'https://a/b.png' });
            expect(doc.images).to.deep.equal([{ data: 'https://a/b.png' }]);
            expect(doc).to.not.have.property('name');
            expect(doc).to.not.have.property('description');
        });
        it('omits images entirely when no artwork given', function () {
            const { doc } = nft.tisDocument({ tick: 'X', name: 'X' });
            expect(doc).to.not.have.property('images');
        });
        it('builds a cross-chain data_ref when imageCoin is given', function () {
            const { doc } = nft.tisDocument({ tick: 'X', imageActionIndex: 55, imageCoin: 'doge' });
            expect(doc.images[0].data_ref).to.equal('action:DOGE:55');
        });
        it('requires tick', function () {
            expect(() => nft.tisDocument({})).to.throw(/tick is required/);
        });
    });

    describe('attachContentParams()', function () {
        it('maps file/issue action indices to LINK coin1/coin2 fields', function () {
            const p = nft.attachContentParams({ coin: 'BTC', fileActionIndex: 1234, issueActionIndex: 4321, memo: 'art' });
            expect(p).to.deep.equal({ coin1: 'BTC', coin1ActionIndex: '1234', coin2: 'BTC', coin2ActionIndex: '4321', memo: 'art' });
        });
        it('supports a cross-chain attachment via fileCoin/issueCoin', function () {
            const p = nft.attachContentParams({ fileCoin: 'BTC', issueCoin: 'DOGE', fileActionIndex: 1, issueActionIndex: 2 });
            expect(p.coin1).to.equal('BTC');
            expect(p.coin2).to.equal('DOGE');
        });
        it('serializes to a valid LINK', function () {
            const r = sdk.actions.createAction({ action: 'LINK', params: nft.attachContentParams({ coin: 'BTC', fileActionIndex: 1234, issueActionIndex: 4321 }) });
            expect(r.actionString).to.equal('LINK|0|BTC|1234|BTC|4321');
        });
        it('requires coin and both action indices', function () {
            expect(() => nft.attachContentParams({ fileActionIndex: 1, issueActionIndex: 2 })).to.throw(/coin .* is required/);
            expect(() => nft.attachContentParams({ coin: 'BTC', issueActionIndex: 2 })).to.throw(/fileActionIndex and issueActionIndex/);
        });
    });

    describe('isNft()', function () {
        it('true for DECIMALS=0 + LOCK_MAX_SUPPLY=1 (UPPER_SNAKE)', function () {
            expect(nft.isNft({ DECIMALS: 0, LOCK_MAX_SUPPLY: 1 })).to.equal(true);
        });
        it('true for camelCase keys', function () {
            expect(nft.isNft({ decimals: 0, lockMaxSupply: 1 })).to.equal(true);
        });
        it('false for a divisible token', function () {
            expect(nft.isNft({ DECIMALS: 8, LOCK_MAX_SUPPLY: 1 })).to.equal(false);
        });
        it('false for an unlocked supply', function () {
            expect(nft.isNft({ DECIMALS: 0, LOCK_MAX_SUPPLY: 0 })).to.equal(false);
        });
        it('false for null/empty input', function () {
            expect(nft.isNft(null)).to.equal(false);
            expect(nft.isNft({})).to.equal(false);
        });
    });

    describe('sdk wiring', function () {
        it('exposes sdk.nft as an NftHelpers instance', function () {
            expect(sdk.nft).to.be.instanceOf(NftHelpers);
        });
    });
});
