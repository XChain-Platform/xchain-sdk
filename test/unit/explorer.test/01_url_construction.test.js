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
const ExplorerClient = require('../../../src/clients/explorer.js');

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

    describe('URL construction', function () {
        it('getBalances hits /{COIN}/api/balances/{address}', async function () {
            nock(BASE).get('/BTC/api/balances/addr1').reply(200, { total: 1, data: [] });
            let result = await client.getBalances('addr1');
            expect(result).to.have.property('total', 1);
        });

        it('getBalancesBatch POSTs {addresses} to /{COIN}/api/balances', async function () {
            nock(BASE).post('/BTC/api/balances', { addresses: ['a1', 'a2'] })
                .reply(200, { a1: { balances: { total: 1, data: [] }, address: null, error: null }, a2: { balances: null, address: null, error: null } });
            let result = await client.getBalancesBatch(['a1', 'a2']);
            expect(result).to.have.all.keys('a1', 'a2');
            expect(result.a1.balances.total).to.equal(1);
        });

        it('getCoinpayObligationsBatch POSTs {addresses} to /{COIN}/api/coinpay_obligations', async function () {
            nock(BASE).post('/BTC/api/coinpay_obligations', { addresses: ['a1', 'a2'] })
                .reply(200, { a1: { coinpay_obligations: { total: 0, data: [] }, error: null }, a2: { coinpay_obligations: null, error: null } });
            let result = await client.getCoinpayObligationsBatch(['a1', 'a2']);
            expect(result).to.have.all.keys('a1', 'a2');
            expect(result.a1.coinpay_obligations.total).to.equal(0);
        });

        it('getToken hits /{COIN}/api/token/{tick}', async function () {
            nock(BASE).get('/BTC/api/token/MYTOKEN').reply(200, { info: { tick: 'MYTOKEN' } });
            let result = await client.getToken('MYTOKEN');
            expect(result.info.tick).to.equal('MYTOKEN');
        });

        // getToken has two shapes a caller cannot guess: the row is
        // NESTED under .info, and a missing tick answers HTTP 404 rather than an
        // empty body. Both naive existence checks are therefore wrong in
        // OPPOSITE directions, which is what these two pin.
        it('the naive top-level check reads an EXISTING token as absent', async function () {
            nock(BASE).get('/BTC/api/token/MYTOKEN').reply(200, { info: { tick: 'MYTOKEN', tick_id: '42' } });
            let row = await client.getToken('MYTOKEN');
            expect(row.tick, 'the fields live under .info, not the top level').to.equal(undefined);
            expect(row.info.tick).to.equal('MYTOKEN');
        });

        it('the naive catch-empty check throws on a MISSING token', async function () {
            nock(BASE).get('/BTC/api/token/NOPE').reply(404, { error: 'not found' });
            let threw = null;
            try { await client.getToken('NOPE'); } catch (e) { threw = e; }
            expect(threw, 'a missing tick is a 404, never an empty 200').to.not.equal(null);
            expect(threw.code).to.equal('EXPLORER_HTTP_404');
        });
    });
});

describe('ExplorerClient', function () {
    beforeEach(resetClient);
    afterEach(cleanNock);

    describe('URL construction', function () {

        it('findToken unwraps the .info envelope', async function () {
            nock(BASE).get('/BTC/api/token/MYTOKEN').reply(200, { info: { tick: 'MYTOKEN', tick_id: '42' } });
            let info = await client.findToken('MYTOKEN');
            expect(info.tick).to.equal('MYTOKEN');
            expect(info.tick_id).to.equal('42');
        });

        it('findToken unwraps the one-element array envelope', async function () {
            nock(BASE).get('/BTC/api/token/MYTOKEN').reply(200, [{ info: { tick: 'MYTOKEN', tick_id: '7' } }]);
            let info = await client.findToken('MYTOKEN');
            expect(info.tick_id).to.equal('7');
        });

        it('findToken answers null on a 404 instead of throwing', async function () {
            nock(BASE).get('/BTC/api/token/NOPE').reply(404, { error: 'not found' });
            expect(await client.findToken('NOPE')).to.equal(null);
        });

        it('findToken answers null when a 200 carries no info record', async function () {
            nock(BASE).get('/BTC/api/token/NOPE').reply(200, {});
            expect(await client.findToken('NOPE')).to.equal(null);
        });

        it('tokenExists is true for a present tick and false for a missing one', async function () {
            nock(BASE).get('/BTC/api/token/MYTOKEN').reply(200, { info: { tick: 'MYTOKEN', tick_id: '42' } });
            expect(await client.tokenExists('MYTOKEN')).to.equal(true);
            nock(BASE).get('/BTC/api/token/NOPE').reply(404, { error: 'not found' });
            expect(await client.tokenExists('NOPE')).to.equal(false);
        });

        // "The explorer could not answer" is not "the token does not exist":
        // collapsing the two would let a blip mint a duplicate ticker.
        it('tokenExists still throws when the explorer fails for any other reason', async function () {
            nock(BASE).get('/BTC/api/token/MYTOKEN').reply(503);
            let threw = null;
            try { await client.tokenExists('MYTOKEN'); } catch (e) { threw = e; }
            expect(threw, 'a 503 must not read as absent').to.not.equal(null);
            expect(threw.code).to.equal('EXPLORER_HTTP_503');

            nock(BASE).get('/BTC/api/token/MYTOKEN').replyWithError('connection reset');
            threw = null;
            try { await client.tokenExists('MYTOKEN'); } catch (e) { threw = e; }
            expect(threw, 'an unreachable host must not read as absent').to.not.equal(null);
            expect(threw.code).to.equal('EXPLORER_NETWORK');
        });
    });
});

describe('ExplorerClient', function () {
    beforeEach(resetClient);
    afterEach(cleanNock);

    describe('URL construction', function () {

        it('findToken forwards opts to the underlying read', async function () {
            nock(BASE).get('/BTC/api/token/MYTOKEN').query({ page: '2' })
                .reply(200, { info: { tick: 'MYTOKEN' } });
            let info = await client.findToken('MYTOKEN', { page: 2 });
            expect(info.tick).to.equal('MYTOKEN');
        });

        it('index.d.ts and the README document the nested shape and the helpers', function () {
            const dts = require('fs').readFileSync(require('path').join(__dirname, '../../../index.d.ts'), 'utf8');
            expect(dts, 'TokenInfo must be declared').to.match(/export interface TokenInfo \{/);
            expect(dts).to.match(/getToken\(tick: string, opts\?: QueryOptions\): Promise<TokenRecord>;/);
            expect(dts).to.match(/findToken\(tick: string, opts\?: QueryOptions\): Promise<TokenInfo \| null>;/);
            expect(dts).to.match(/tokenExists\(tick: string, opts\?: QueryOptions\): Promise<boolean>;/);

            const readme = require('fs').readFileSync(require('path').join(__dirname, '../../../README.md'), 'utf8');
            expect(readme, 'the nested envelope must be documented').to.match(/token\.info\.tick_id/);
            expect(readme, 'the 404-on-missing behaviour must be documented').to.match(/EXPLORER_HTTP_404/);
            expect(readme).to.match(/sdk\.tokenExists\(/);
        });

        it('getTransaction hits /{COIN}/api/transaction/{query}/{type}', async function () {
            nock(BASE).get('/BTC/api/transaction/abc123/tx_hash').reply(200, { tx_hash: 'abc123' });
            let result = await client.getTransaction('abc123', 'tx_hash');
            expect(result.tx_hash).to.equal('abc123');
        });

        it('getSends hits /{COIN}/api/sends/{query}/{type}', async function () {
            nock(BASE).get('/BTC/api/sends/addr1/address').reply(200, { total: 5, data: [] });
            let result = await client.getSends('addr1', 'address');
            expect(result.total).to.equal(5);
        });

        it('getMarket hits /{COIN}/api/market/{tick1}/{tick2}', async function () {
            nock(BASE).get('/BTC/api/market/TOKEN_A/TOKEN_B').reply(200, { price: '1.5' });
            let result = await client.getMarket('TOKEN_A', 'TOKEN_B');
            expect(result.price).to.equal('1.5');
        });

        it('getMarketHistory with address', async function () {
            nock(BASE).get('/BTC/api/market/A/B/history/addr1').reply(200, { data: [] });
            let result = await client.getMarketHistory('A', 'B', 'addr1');
            expect(result).to.have.property('data');
        });

        it('getMarketHistory without address', async function () {
            nock(BASE).get('/BTC/api/market/A/B/history').reply(200, { data: [] });
            let result = await client.getMarketHistory('A', 'B', null);
            expect(result).to.have.property('data');
        });
    });
});

describe('ExplorerClient', function () {
    beforeEach(resetClient);
    afterEach(cleanNock);

    describe('URL construction', function () {

        it('search uses /explorer/ path', async function () {
            nock(BASE).get('/BTC/explorer/search/test/token').reply(200, { data: [] });
            let result = await client.search('test', 'token');
            expect(result).to.have.property('data');
        });

        it('getStakes hits /{COIN}/api/stakes/{query}/{type}', async function () {
            nock(BASE).get('/BTC/api/stakes/addr1/address').reply(200, { total: 1, data: [{ tier: 2 }] });
            let result = await client.getStakes('addr1', 'address');
            expect(result.data[0].tier).to.equal(2);
        });

        it('getStakes without args hits /{COIN}/api/stakes', async function () {
            nock(BASE).get('/BTC/api/stakes').reply(200, { total: 0, data: [] });
            let result = await client.getStakes();
            expect(result).to.have.property('data');
        });

        it('getDelegations hits /{COIN}/api/delegations/{query}/{type}', async function () {
            nock(BASE).get('/BTC/api/delegations/addr1/address').reply(200, { data: [{ pubkey: 'abc' }] });
            let result = await client.getDelegations('addr1', 'address');
            expect(result.data[0].pubkey).to.equal('abc');
        });

        it('getValidators hits /{COIN}/api/validators', async function () {
            nock(BASE).get('/BTC/api/validators').reply(200, { data: [{ pubkey: 'v1' }] });
            let result = await client.getValidators();
            expect(result.data[0].pubkey).to.equal('v1');
        });

        it('getValidatorRewards hits /{COIN}/api/rewards/{query}/{type}', async function () {
            nock(BASE).get('/BTC/api/rewards/addr1/address').reply(200, { total: 2, data: [] });
            let result = await client.getValidatorRewards('addr1', 'address');
            expect(result.total).to.equal(2);
        });

        it('getContractStakes hits /{COIN}/api/contract_stakes/{query}/{type}', async function () {
            nock(BASE).get('/BTC/api/contract_stakes/addr1/address').reply(200, { total: 1, data: [{ amount: '100' }] });
            let result = await client.getContractStakes('addr1', 'address');
            expect(result.data[0].amount).to.equal('100');
        });

        it('getContractStakes without args hits /{COIN}/api/contract_stakes', async function () {
            nock(BASE).get('/BTC/api/contract_stakes').reply(200, { total: 0, data: [] });
            let result = await client.getContractStakes();
            expect(result).to.have.property('data');
        });
    });
});

describe('ExplorerClient', function () {
    beforeEach(resetClient);
    afterEach(cleanNock);

    describe('URL construction', function () {

        it('getContractUnstakes hits /{COIN}/api/contract_unstakes/{query}/{type}', async function () {
            nock(BASE).get('/BTC/api/contract_unstakes/42/contract').reply(200, { total: 1, data: [{ action_index: 99 }] });
            let result = await client.getContractUnstakes('42', 'contract');
            expect(result.data[0].action_index).to.equal(99);
        });

        it('getSlashEvents hits /{COIN}/api/slash_events/{query}/{type}', async function () {
            nock(BASE).get('/BTC/api/slash_events/42/contract').reply(200, { total: 1, data: [{ slashed_amount: '50' }] });
            let result = await client.getSlashEvents('42', 'contract');
            expect(result.data[0].slashed_amount).to.equal('50');
        });

        it('getXcalls hits /{COIN}/api/xcalls/{query}/{type}', async function () {
            nock(BASE).get('/BTC/api/xcalls/42/contract').reply(200, { total: 1, data: [{ call_id: 'abc', request_status: 'pending' }] });
            let result = await client.getXcalls('42', 'contract');
            expect(result.data[0].call_id).to.equal('abc');
        });

        it('getXcalls without args hits /{COIN}/api/xcalls', async function () {
            nock(BASE).get('/BTC/api/xcalls').reply(200, { total: 0, data: [] });
            let result = await client.getXcalls();
            expect(result).to.have.property('data');
        });

        it('getXcall hits /{COIN}/api/xcall/{callId} and returns the lifecycle object', async function () {
            nock(BASE).get('/BTC/api/xcall/' + 'a'.repeat(64)).reply(200,
                { call_id: 'a'.repeat(64), request_status: 'completed', execution: { result_status: 'ok' }, callback_delivery: null });
            let result = await client.getXcall('a'.repeat(64));
            expect(result.request_status).to.equal('completed');
            expect(result.execution.result_status).to.equal('ok');
        });

        // Newly-wrapped explorer entity routes (server-ahead-of-client drift fix).
        it('getControllers hits /{COIN}/api/controllers', async function () {
            nock(BASE).get('/BTC/api/controllers').reply(200, { data: [] });
            expect(await client.getControllers()).to.have.property('data');
        });

        it('getContractDelegations hits /{COIN}/api/contract_delegations/{query}/{type}', async function () {
            nock(BASE).get('/BTC/api/contract_delegations/5/contract').reply(200, { data: [{ id: 1 }] });
            let r = await client.getContractDelegations('5', 'contract');
            expect(r.data[0].id).to.equal(1);
        });

        it('getCrossChainSettlements bare hits /{COIN}/api/cross_chain_settlements', async function () {
            nock(BASE).get('/BTC/api/cross_chain_settlements').reply(200, { data: [] });
            expect(await client.getCrossChainSettlements()).to.have.property('data');
        });
    });
});

describe('ExplorerClient', function () {
    beforeEach(resetClient);
    afterEach(cleanNock);

    describe('URL construction', function () {

        it('getAnchors hits /{COIN}/api/anchors/{query}/{type}', async function () {
            nock(BASE).get('/BTC/api/anchors/regtest/network').reply(200, { data: [{ chain: 'BTC' }] });
            let r = await client.getAnchors('regtest', 'network');
            expect(r.data[0].chain).to.equal('BTC');
        });

        // Newly-wrapped SPV checkpoint + proof routes.
        it('getCheckpoints hits /{COIN}/api/checkpoints', async function () {
            nock(BASE).get('/BTC/api/checkpoints').reply(200, { checkpoints: [], count: 0 });
            expect(await client.getCheckpoints()).to.have.property('count', 0);
        });

        it('getCheckpointRange passes ?from=&to=', async function () {
            nock(BASE).get('/BTC/api/checkpoints/range').query({ from: '100', to: '200' }).reply(200, { checkpoints: [] });
            expect(await client.getCheckpointRange(100, 200)).to.have.property('checkpoints');
        });

        it('getBalanceProof passes ?height= and the address/tick path', async function () {
            nock(BASE).get('/BTC/api/proof/balance/addr1/MYTOKEN').query({ height: '500' }).reply(200, { proof: [] });
            expect(await client.getBalanceProof('addr1', 'MYTOKEN', { height: 500 })).to.have.property('proof');
        });

        it('getActionProof hits /{COIN}/api/proof/action/{actionIndex}', async function () {
            nock(BASE).get('/BTC/api/proof/action/42').reply(200, { proof: [] });
            expect(await client.getActionProof(42)).to.have.property('proof');
        });

        it('getContractStateProof hits /{COIN}/api/proof/contract-state/{contractIndex}/{key}', async function () {
            nock(BASE).get('/BTC/api/proof/contract-state/7/balances').reply(200, { code: 'EMPTY' });
            expect(await client.getContractStateProof(7, 'balances')).to.have.property('code');
        });

        it('getCheckpointVerify hits /{COIN}/api/checkpoint/{blockIndex}/verify', async function () {
            nock(BASE).get('/BTC/api/checkpoint/494/verify').reply(200, { checkpoint: { block_index: 494 }, validators: [] });
            let r = await client.getCheckpointVerify(494);
            expect(r.checkpoint.block_index).to.equal(494);
        });

    });
});
