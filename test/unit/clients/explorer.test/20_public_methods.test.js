// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect } = require('chai');
const nock = require('nock');
const sinon = require('sinon');
const ExplorerClient = require('../../../../src/clients/explorer.js');

const BASE = 'http://explorer.test:8080';
let client;

function resetClient() {
    client = new ExplorerClient({
        network: 'bitcoin-mainnet',
        explorerUrl: 'explorer.test',
        explorerPort: 8080,
        retry: false
    });
}

function cleanNock() {
    nock.cleanAll();
}

describe('ExplorerClient', function () {
    beforeEach(resetClient);
    afterEach(cleanNock);

    describe('public methods', function () {
        const methods = [
            'getBalances', 'getBalancesBatch', 'getAddress', 'getHolders', 'getCredits', 'getDebits', 'getEscrows',
            'getToken', 'findToken', 'tokenExists', 'getProject', 'getTokens', 'getIssues',
            'getTransaction', 'getAction', 'getBlock', 'getHistory',
            'getAddresses', 'getAirdrops', 'getBatches', 'getBroadcasts', 'getCallbacks',
            'getCoinpays', 'getCoinpayExpires', 'getCoinpayObligations', 'getCoinpayObligationsBatch',
            'getDestroys', 'getDispensers', 'getDispenses',
            'getDispenserCancels', 'getDispenserCloses', 'getDispenserExpires', 'getDispenserEdits',
            'getDividends', 'getFees',
            'getFiles', 'getLinks', 'getLists', 'getMessages', 'getMints', 'getOrders',
            'getOrderCancels', 'getOrderEdits', 'getOrderExpires', 'getOrderMatches',
            'getSends', 'getSleeps', 'getSwaps',
            'getSwapCancels', 'getSwapEdits', 'getSwapExpires', 'getSweeps',
            'getPrices', 'getPriceSnapshots',
            'getStakes', 'getUnstakes', 'getStakeKeyRevocations', 'getCollects',
            'getDelegations', 'getValidators', 'getValidatorRewards',
            'getContractStakes', 'getContractUnstakes', 'getContractDelegations',
            'getSlashEvents', 'getCapabilitySlashEvents',
            'getXcalls', 'getXcall',
            'getControllers', 'getDeployChunks', 'getFullNodeVerifications',
            'getCrossChainMatches', 'getCrossChainSettlements', 'getAnchors', 'getOraclePrices',
            'getValidatorCapabilities', 'getGovernanceProposals', 'getGovernanceVotes',
            'getPolls', 'getPoll', 'getPollResults', 'getVotes',
            'getCheckpoints', 'getCheckpointRange', 'getCheckpointVerify',
            'getBalanceProof', 'getActionProof', 'getValidatorSetProof', 'getContractStateProof',
            'getMarkets', 'getMarket', 'getMarketHistory', 'getMarketOrders', 'getOrderbook',
            'getStatus', 'getMempool', 'getNetwork', 'search'
        ];
        for (let method of methods) {
            it('has ' + method + '()', function () {
                expect(client[method]).to.be.a('function');
            });
        }

        it('has 133 public methods', function () {
            // 113 = 112 + getPreflight (validity-first pre-flight proxy).
            // 117 = 113 + the four BET reads: getBetFeeds, getBetFeed,
            // getBets, getOracleStats.
            // 118 = 117 + getOracleFeeQuote (dispenser oracle usage fee).
            // 119 = 118 + freshness (the explorer's per-response tip marker).
            // 121 = 119 + the two batch reads: getBalancesBatch,
            // getCoinpayObligationsBatch.
            // 123 = 121 + the two non-throwing token existence reads:
            // findToken, tokenExists.
            // 133 = 123 + the ten transport and read helpers that dropped their
            // underscore: buildClient, deriveCoinPrefix, buildParams, get, post,
            // recordFreshness, handleError, assertBatchAddresses, assertBatchBody,
            // siblingCoin.
            let publicMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(client))
                .filter(m => !m.startsWith('_') && m !== 'constructor');
            expect(publicMethods).to.have.length(133);
        });
    });
});
