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
const ExplorerClient = require('../../src/explorer.js');

describe('ExplorerClient', function () {

    const BASE = 'http://explorer.test:8080';
    let client;

    beforeEach(function () {
        client = new ExplorerClient({
            network: 'bitcoin-mainnet',
            explorerUrl: 'explorer.test',
            explorerPort: 8080,
            retry: false
        });
    });

    afterEach(function () {
        nock.cleanAll();
    });

    /*
     *  fileRawUrl
     */

    describe('fileRawUrl()', function () {
        it('builds the absolute raw FILE URL for the configured explorer', function () {
            expect(client.fileRawUrl(123)).to.equal('http://explorer.test:8080/BTC/api/file/123/raw');
        });
        it('respects an http(s) baseUrl and strips trailing slashes', function () {
            let c = new ExplorerClient({ network: 'bitcoin-regtest', explorerUrl: 'https://explorer.xchain.io/', retry: false });
            expect(c.fileRawUrl('7')).to.equal('https://explorer.xchain.io/RBTC/api/file/7/raw');
        });
        it('resolves a sibling-chain coin at the same network tier', function () {
            // Mainnet client: DOGE → DOGE
            expect(client.fileRawUrl(9, 'DOGE')).to.equal('http://explorer.test:8080/DOGE/api/file/9/raw');
            // Regtest client: DOGE → RDOGE (tier implied by the client's network)
            let c = new ExplorerClient({ network: 'bitcoin-regtest', explorerUrl: 'https://explorer.xchain.io/', retry: false });
            expect(c.fileRawUrl('7', 'doge')).to.equal('https://explorer.xchain.io/RDOGE/api/file/7/raw');
        });
    });

    /*
     *  Coin prefix derivation
     */

    describe('coin prefix', function () {
        const cases = {
            'bitcoin-mainnet': 'BTC', 'bitcoin-testnet': 'TBTC', 'bitcoin-regtest': 'RBTC',
            'litecoin-mainnet': 'LTC', 'litecoin-testnet': 'TLTC', 'litecoin-regtest': 'RLTC',
            'dogecoin-mainnet': 'DOGE', 'dogecoin-testnet': 'TDOGE', 'dogecoin-regtest': 'RDOGE'
        };
        for (let [network, prefix] of Object.entries(cases)) {
            it(network + ' → ' + prefix, function () {
                let c = new ExplorerClient({ network });
                expect(c.coin).to.equal(prefix);
            });
        }

        it('throws on invalid network', function () {
            expect(() => new ExplorerClient({ network: 'invalid' })).to.throw(/Unknown network/);
        });

        it('defaults to BTC when no network', function () {
            let c = new ExplorerClient({});
            expect(c.coin).to.equal('BTC');
        });
    });

    /*
     *  URL construction
     */

    describe('URL construction', function () {
        it('getBalances hits /{COIN}/api/balances/{address}', async function () {
            nock(BASE).get('/BTC/api/balances/addr1').reply(200, { total: 1, data: [] });
            let result = await client.getBalances('addr1');
            expect(result).to.have.property('total', 1);
        });

        it('getToken hits /{COIN}/api/token/{tick}', async function () {
            nock(BASE).get('/BTC/api/token/MYTOKEN').reply(200, { info: { tick: 'MYTOKEN' } });
            let result = await client.getToken('MYTOKEN');
            expect(result.info.tick).to.equal('MYTOKEN');
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
    });

    /*
     *  Contract permissions manifest (programmable policy layer)
     */

    describe('getContractManifest()', function () {
        it('normalizes a snake_case manifest (permissions JSON string + max_take_bps)', async function () {
            nock(BASE).get('/BTC/api/contract/42').reply(200, { action_index: 42, permissions: '["SEND","MINT"]', max_take_bps: 300 });
            let m = await client.getContractManifest(42);
            expect(m).to.deep.equal({ permissions: ['SEND', 'MINT'], maxTakeBps: 300 });
        });
        it('passes through an already-parsed permissions array', async function () {
            nock(BASE).get('/BTC/api/contract/7').reply(200, { action_index: 7, permissions: ['SEND'], max_take_bps: null });
            let m = await client.getContractManifest(7);
            expect(m).to.deep.equal({ permissions: ['SEND'], maxTakeBps: null });
        });
        it('returns nulls when the contract declares no manifest', async function () {
            nock(BASE).get('/BTC/api/contract/9').reply(200, { action_index: 9 });
            let m = await client.getContractManifest(9);
            expect(m).to.deep.equal({ permissions: null, maxTakeBps: null });
        });
    });

    /*
     *  Pagination params
     */

    describe('pagination', function () {
        it('passes page, limit, sortorder as query params', async function () {
            nock(BASE)
                .get('/BTC/api/balances/addr1')
                .query({ page: '2', limit: '50', sortorder: 'DESC' })
                .reply(200, { total: 100, data: [] });
            let result = await client.getBalances('addr1', { page: 2, limit: 50, sortorder: 'DESC' });
            expect(result.total).to.equal(100);
        });

        it('omits undefined params', async function () {
            nock(BASE)
                .get('/BTC/api/balances/addr1')
                .query({ page: '1' })
                .reply(200, { data: [] });
            let result = await client.getBalances('addr1', { page: 1 });
            expect(result).to.have.property('data');
        });
    });

    /*
     *  Error handling
     */

    describe('error handling', function () {
        it('wraps HTTP 404 as SDKExplorerError', async function () {
            nock(BASE).get('/BTC/api/token/NOEXIST').reply(404, { error: 'not found' });
            try {
                await client.getToken('NOEXIST');
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.name).to.equal('SDKExplorerError');
                expect(e.code).to.equal('EXPLORER_HTTP_404');
                expect(e.details.status).to.equal(404);
            }
        });

        it('wraps HTTP 503 as SDKExplorerError', async function () {
            nock(BASE).get('/BTC/api/status').reply(503);
            try {
                await client.getStatus();
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.code).to.equal('EXPLORER_HTTP_503');
            }
        });

        it('wraps network errors', async function () {
            nock(BASE).get('/BTC/api/status').replyWithError('connection reset');
            try {
                await client.getStatus();
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.name).to.equal('SDKExplorerError');
                expect(e.code).to.equal('EXPLORER_NETWORK');
            }
        });
    });

    /*
     *  setBase
     */

    describe('setBase', function () {
        it('no-ops when both url and port are falsy', function () {
            const origClient = client.client;
            client.setBase(null, null);
            expect(client.client).to.equal(origClient);
        });

        it('no-ops when url/port unchanged', function () {
            const origClient = client.client;
            client.setBase('explorer.test', 8080);
            expect(client.client).to.equal(origClient);
        });

        it('rebuilds client when url changes', function () {
            const origClient = client.client;
            client.setBase('new-explorer.test', 8080);
            expect(client.client).to.not.equal(origClient);
            expect(client.baseUrl).to.equal('new-explorer.test');
        });

        it('rebuilds client when port changes', function () {
            const origClient = client.client;
            client.setBase('explorer.test', 9090);
            expect(client.client).to.not.equal(origClient);
            expect(client.port).to.equal(9090);
        });
    });

    /*
     *  readyHook
     */

    describe('readyHook', function () {
        afterEach(function () {
            sinon.restore();
        });

        it('awaits readyHook before each GET request', async function () {
            let hookCalled = false;
            const hooked = new ExplorerClient({
                network: 'bitcoin-mainnet',
                explorerUrl: 'explorer.test',
                explorerPort: 8080,
                retry: false,
                readyHook: async () => { hookCalled = true; }
            });
            nock(BASE).get('/BTC/api/status').reply(200, { status: 'ok' });
            await hooked.getStatus();
            expect(hookCalled).to.be.true;
        });
    });

    /*
     *  hooks
     */

    describe('hooks', function () {
        afterEach(function () {
            sinon.restore();
        });

        it('fires onRequest and onResponse hooks on success', async function () {
            const onRequest = sinon.spy();
            const onResponse = sinon.spy();
            const hooked = new ExplorerClient({
                network: 'bitcoin-mainnet',
                explorerUrl: 'explorer.test',
                explorerPort: 8080,
                retry: false,
                hooks: { onRequest, onResponse }
            });
            nock(BASE).get('/BTC/api/status').reply(200, { status: 'ok' });
            await hooked.getStatus();
            expect(onRequest.calledOnce).to.be.true;
            expect(onRequest.firstCall.args[0].service).to.equal('explorer');
            expect(onResponse.calledOnce).to.be.true;
        });

        it('fires onError hook on failure', async function () {
            const onError = sinon.spy();
            const hooked = new ExplorerClient({
                network: 'bitcoin-mainnet',
                explorerUrl: 'explorer.test',
                explorerPort: 8080,
                retry: false,
                hooks: { onError }
            });
            nock(BASE).get('/BTC/api/status').replyWithError('network down');
            try { await hooked.getStatus(); } catch (e) { /* expected */ }
            expect(onError.calledOnce).to.be.true;
        });

        it('fires onRetry hook on retryable failure', async function () {
            const onRetry = sinon.spy();
            const hooked = new ExplorerClient({
                network: 'bitcoin-mainnet',
                explorerUrl: 'explorer.test',
                explorerPort: 8080,
                retry: { maxRetries: 1, baseDelay: 0, maxDelay: 0, backoffFactor: 1 },
                hooks: { onRetry }
            });
            nock(BASE).get('/BTC/api/status').reply(503, 'unavailable');
            nock(BASE).get('/BTC/api/status').reply(200, { status: 'ok' });
            await hooked.getStatus();
            expect(onRetry.calledOnce).to.be.true;
        });
    });

    /*
     *  Timeout error
     */

    describe('timeout errors', function () {
        afterEach(function () {
            sinon.restore();
        });

        it('wraps ECONNABORTED as EXPLORER_TIMEOUT', async function () {
            const noRetry = new ExplorerClient({
                network: 'bitcoin-mainnet',
                explorerUrl: 'explorer.test',
                explorerPort: 8080,
                retry: false
            });
            const err = new Error('timeout exceeded');
            err.code = 'ECONNABORTED';
            sinon.stub(noRetry.client, 'get').rejects(err);
            try {
                await noRetry.getStatus();
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.name).to.equal('SDKExplorerError');
                expect(e.code).to.equal('EXPLORER_TIMEOUT');
            }
        });
    });

    /*
     *  HTTPS base URL
     */

    describe('HTTPS base URL', function () {
        it('builds client with https agent when url starts with https', function () {
            const c = new ExplorerClient({
                network: 'bitcoin-mainnet',
                explorerUrl: 'https://explorer.xchain.io'
            });
            expect(c.client.defaults.baseURL).to.equal('https://explorer.xchain.io');
        });
    });

    /*
     *  Balance & Address Methods — direct calls
     */

    describe('balance & address methods', function () {
        it('getAddress returns result', async function () {
            nock(BASE).get('/BTC/api/address/addr1').reply(200, { address: 'addr1', total_received: '100' });
            const r = await client.getAddress('addr1');
            expect(r.address).to.equal('addr1');
        });

        it('getPublicKey returns result', async function () {
            nock(BASE).get('/BTC/api/pubkey/addr1').reply(200, { pubkey: '02abc' });
            const r = await client.getPublicKey('addr1');
            expect(r.pubkey).to.equal('02abc');
        });

        it('getHolders returns result', async function () {
            nock(BASE).get('/BTC/api/holders/TOKEN').reply(200, { total: 5, data: [] });
            const r = await client.getHolders('TOKEN');
            expect(r.total).to.equal(5);
        });

        it('getCredits returns result', async function () {
            nock(BASE).get('/BTC/api/credits/addr1/address').reply(200, { total: 1, data: [] });
            const r = await client.getCredits('addr1', 'address');
            expect(r.total).to.equal(1);
        });

        it('getDebits returns result', async function () {
            nock(BASE).get('/BTC/api/debits/addr1/address').reply(200, { total: 2, data: [] });
            const r = await client.getDebits('addr1', 'address');
            expect(r.total).to.equal(2);
        });

        it('getEscrows returns result', async function () {
            nock(BASE).get('/BTC/api/escrows/addr1/address').reply(200, { data: [] });
            const r = await client.getEscrows('addr1', 'address');
            expect(r).to.have.property('data');
        });
    });

    /*
     *  Token methods — direct calls
     */

    describe('token methods', function () {
        it('getTokens returns result', async function () {
            nock(BASE).get('/BTC/api/tokens/addr1/address').reply(200, { total: 3, data: [] });
            const r = await client.getTokens('addr1', 'address');
            expect(r.total).to.equal(3);
        });

        it('getIssues returns result', async function () {
            nock(BASE).get('/BTC/api/issues/TOKEN/token').reply(200, { total: 1, data: [] });
            const r = await client.getIssues('TOKEN', 'token');
            expect(r.total).to.equal(1);
        });
    });

    /*
     *  Transaction & History methods — direct calls
     */

    describe('transaction & history methods', function () {
        it('getAction returns result', async function () {
            nock(BASE).get('/BTC/api/action/42').reply(200, { action_index: 42 });
            const r = await client.getAction(42);
            expect(r.action_index).to.equal(42);
        });

        it('getActions returns result', async function () {
            nock(BASE).get('/BTC/api/actions').reply(200, { total: 10, data: [] });
            const r = await client.getActions();
            expect(r.total).to.equal(10);
        });

        it('getBlock returns result', async function () {
            nock(BASE).get('/BTC/api/block/100').reply(200, { block_index: 100 });
            const r = await client.getBlock(100);
            expect(r.block_index).to.equal(100);
        });

        it('getHistory returns result', async function () {
            nock(BASE).get('/BTC/api/history/addr1/address').reply(200, { total: 5, data: [] });
            const r = await client.getHistory('addr1', 'address');
            expect(r.total).to.equal(5);
        });
    });

    /*
     *  ACTION-specific methods — direct calls (a representative sample)
     */

    describe('action-specific methods', function () {
        const pairs = [
            ['getAddresses', 'addresses'],
            ['getAirdrops', 'airdrops'],
            ['getBatches', 'batches'],
            ['getBroadcasts', 'broadcasts'],
            ['getCallbacks', 'callbacks'],
            ['getDestroys', 'destroys'],
            ['getCoinpays', 'coinpays'],
            ['getCoinpayExpires', 'coinpay_expires'],
            ['getCoinpayObligations', 'coinpay_obligations'],
            ['getDispensers', 'dispensers'],
            ['getDispenses', 'dispenses'],
            ['getDispenserCancels', 'dispenser_cancels'],
            ['getDispenserCloses', 'dispenser_closes'],
            ['getDispenserExpires', 'dispenser_expires'],
            ['getDispenserEdits', 'dispenser_edits'],
            ['getDividends', 'dividends'],
            ['getFees', 'fees'],
            ['getFiles', 'files'],
            ['getLinks', 'links'],
            ['getLists', 'lists'],
            ['getMessages', 'messages'],
            ['getMints', 'mints'],
            ['getOrders', 'orders'],
            ['getOrderCancels', 'order_cancels'],
            ['getOrderEdits', 'order_edits'],
            ['getOrderExpires', 'order_expires'],
            ['getSleeps', 'sleeps'],
            ['getSwaps', 'swaps'],
            ['getSwapCancels', 'swap_cancels'],
            ['getSwapEdits', 'swap_edits'],
            ['getSwapExpires', 'swap_expires'],
            ['getSweeps', 'sweeps']
        ];

        for (const [method, path] of pairs) {
            it(method + ' returns result', async function () {
                nock(BASE).get('/BTC/api/' + path + '/addr1/address').reply(200, { total: 1, data: [] });
                const r = await client[method]('addr1', 'address');
                expect(r.total).to.equal(1);
            });
        }

        it('getOrderMatches with query returns result', async function () {
            nock(BASE).get('/BTC/api/order_matches/100/block').reply(200, { total: 1, data: [] });
            const r = await client.getOrderMatches(100, 'block');
            expect(r.total).to.equal(1);
        });

        it('getOrderMatches without query returns result', async function () {
            nock(BASE).get('/BTC/api/order_matches').reply(200, { total: 0, data: [] });
            const r = await client.getOrderMatches(null);
            expect(r.total).to.equal(0);
        });

        it('getSwapMatches with query returns result', async function () {
            nock(BASE).get('/BTC/api/swap_matches/100/block').reply(200, { total: 1, data: [] });
            const r = await client.getSwapMatches(100, 'block');
            expect(r.total).to.equal(1);
        });

        it('getSwapMatches without query returns result', async function () {
            nock(BASE).get('/BTC/api/swap_matches').reply(200, { total: 0, data: [] });
            const r = await client.getSwapMatches(null);
            expect(r.total).to.equal(0);
        });
    });

    /*
     *  Fee methods — direct calls
     */

    describe('fee methods', function () {
        it('getFeeQuote returns result', async function () {
            nock(BASE)
                .get('/BTC/api/feequote')
                .query({ action: 'SEND', params: '0|TOKEN|100|addr1', source: 'addr1' })
                .reply(200, { supported: true, valid: true, requiredFeeSats: 1000 });
            const r = await client.getFeeQuote({ action: 'SEND', params: ['0', 'TOKEN', '100', 'addr1'], source: 'addr1' });
            expect(r.supported).to.be.true;
        });

        it('getFeeQuote with string params', async function () {
            nock(BASE)
                .get('/BTC/api/feequote')
                .query({ action: 'SEND', params: '0|TOKEN|100' })
                .reply(200, { supported: true });
            const r = await client.getFeeQuote({ action: 'SEND', params: '0|TOKEN|100' });
            expect(r.supported).to.be.true;
        });

        it('getFeeQuote with feeOutputSats', async function () {
            nock(BASE)
                .get('/BTC/api/feequote')
                .query({ action: 'SEND', feeOutputSats: '5000' })
                .reply(200, { supported: true });
            const r = await client.getFeeQuote({ action: 'SEND', feeOutputSats: 5000 });
            expect(r.supported).to.be.true;
        });

        it('getFeeSchedule returns result', async function () {
            nock(BASE).get('/BTC/api/feeschedule').reply(200, { actions: [] });
            const r = await client.getFeeSchedule();
            expect(r).to.have.property('actions');
        });
    });

    /*
     *  Price methods — direct calls
     */

    describe('price methods', function () {
        it('getPrices with query returns result', async function () {
            nock(BASE).get('/BTC/api/prices/addr1/address').reply(200, { total: 1, data: [] });
            const r = await client.getPrices('addr1', 'address');
            expect(r.total).to.equal(1);
        });

        it('getPrices without query returns result', async function () {
            nock(BASE).get('/BTC/api/prices').reply(200, { total: 0, data: [] });
            const r = await client.getPrices(null, 'address');
            expect(r.total).to.equal(0);
        });

        it('getPriceSnapshots with query returns result', async function () {
            nock(BASE).get('/BTC/api/price_snapshots/BTC-USD/pair').reply(200, { data: [] });
            const r = await client.getPriceSnapshots('BTC-USD', 'pair');
            expect(r).to.have.property('data');
        });

        it('getPriceSnapshots without query returns result', async function () {
            nock(BASE).get('/BTC/api/price_snapshots').reply(200, { data: [] });
            const r = await client.getPriceSnapshots(null, 'pair');
            expect(r).to.have.property('data');
        });
    });

    /*
     *  Contract / VM methods — direct calls
     */

    describe('contract/VM methods', function () {
        it('getContract returns result', async function () {
            nock(BASE).get('/BTC/api/contract/42').reply(200, { action_index: 42 });
            const r = await client.getContract(42);
            expect(r.action_index).to.equal(42);
        });

        it('getContracts with query returns result', async function () {
            nock(BASE).get('/BTC/api/contracts/addr1/address').reply(200, { total: 1, data: [] });
            const r = await client.getContracts('addr1', 'address');
            expect(r.total).to.equal(1);
        });

        it('getContracts without query returns result', async function () {
            nock(BASE).get('/BTC/api/contracts').reply(200, { total: 0, data: [] });
            const r = await client.getContracts(null, 'address');
            expect(r.total).to.equal(0);
        });

        it('getContractState with key returns result', async function () {
            nock(BASE).get('/BTC/api/contract/42/state/mykey').reply(200, { value: 'hello' });
            const r = await client.getContractState(42, 'mykey');
            expect(r.value).to.equal('hello');
        });

        it('getContractState without key returns result', async function () {
            nock(BASE).get('/BTC/api/contract/42/state').reply(200, { state: {} });
            const r = await client.getContractState(42);
            expect(r).to.have.property('state');
        });

        it('getContractBalance with tick returns result', async function () {
            nock(BASE).get('/BTC/api/contract/42/balance/TOKEN').reply(200, { balance: '1000' });
            const r = await client.getContractBalance(42, 'TOKEN');
            expect(r.balance).to.equal('1000');
        });

        it('getContractBalance without tick returns result', async function () {
            nock(BASE).get('/BTC/api/contract/42/balance').reply(200, { balances: [] });
            const r = await client.getContractBalance(42);
            expect(r).to.have.property('balances');
        });

        it('getExecution returns result', async function () {
            nock(BASE).get('/BTC/api/execution/99').reply(200, { action_index: 99 });
            const r = await client.getExecution(99);
            expect(r.action_index).to.equal(99);
        });

        it('getExecutions with contractActionIndex returns result', async function () {
            nock(BASE).get('/BTC/api/executions/42').reply(200, { total: 5, data: [] });
            const r = await client.getExecutions(42);
            expect(r.total).to.equal(5);
        });

        it('getExecutions without contractActionIndex returns result', async function () {
            nock(BASE).get('/BTC/api/executions').reply(200, { total: 0, data: [] });
            const r = await client.getExecutions(null);
            expect(r.total).to.equal(0);
        });

        it('getDeposits returns result', async function () {
            nock(BASE).get('/BTC/api/deposits/addr1/address').reply(200, { total: 1, data: [] });
            const r = await client.getDeposits('addr1', 'address');
            expect(r.total).to.equal(1);
        });

        it('getWithdrawals returns result', async function () {
            nock(BASE).get('/BTC/api/withdrawals/addr1/address').reply(200, { total: 1, data: [] });
            const r = await client.getWithdrawals('addr1', 'address');
            expect(r.total).to.equal(1);
        });
    });

    /*
     *  Attestation methods — direct calls
     */

    describe('attestation methods', function () {
        it('getAttestations with query returns result', async function () {
            nock(BASE).get('/BTC/api/attestations/addr1/address').reply(200, { total: 1, data: [] });
            const r = await client.getAttestations('addr1', 'address');
            expect(r.total).to.equal(1);
        });

        it('getAttestations without query returns result', async function () {
            nock(BASE).get('/BTC/api/attestations').reply(200, { total: 0, data: [] });
            const r = await client.getAttestations(null, 'address');
            expect(r.total).to.equal(0);
        });
    });

    /*
     *  Market methods — additional coverage
     */

    describe('market methods', function () {
        it('getMarkets with tick returns result', async function () {
            nock(BASE).get('/BTC/api/markets/TOKEN').reply(200, { data: [] });
            const r = await client.getMarkets('TOKEN');
            expect(r).to.have.property('data');
        });

        it('getMarkets without tick returns result', async function () {
            nock(BASE).get('/BTC/api/markets').reply(200, { data: [] });
            const r = await client.getMarkets();
            expect(r).to.have.property('data');
        });

        it('getMarketOrders with address returns result', async function () {
            nock(BASE).get('/BTC/api/market/A/B/orders/addr1').reply(200, { data: [] });
            const r = await client.getMarketOrders('A', 'B', 'addr1');
            expect(r).to.have.property('data');
        });

        it('getMarketOrders without address returns result', async function () {
            nock(BASE).get('/BTC/api/market/A/B/orders').reply(200, { data: [] });
            const r = await client.getMarketOrders('A', 'B', null);
            expect(r).to.have.property('data');
        });

        it('getOrderbook returns result', async function () {
            nock(BASE).get('/BTC/api/market/A/B/orderbook').reply(200, { asks: [], bids: [] });
            const r = await client.getOrderbook('A', 'B');
            expect(r).to.have.property('asks');
        });
    });

    /*
     *  Staking methods — additional
     */

    describe('staking methods', function () {
        it('getContractUnstakes without query returns result', async function () {
            nock(BASE).get('/BTC/api/contract_unstakes').reply(200, { total: 0, data: [] });
            const r = await client.getContractUnstakes(null, 'address');
            expect(r.total).to.equal(0);
        });

        it('getSlashEvents without query returns result', async function () {
            nock(BASE).get('/BTC/api/slash_events').reply(200, { total: 0, data: [] });
            const r = await client.getSlashEvents(null, 'contract');
            expect(r.total).to.equal(0);
        });

        it('getAttestations slash_events with query (type cover)', async function () {
            nock(BASE).get('/BTC/api/slash_events/42/contract').reply(200, { total: 1, data: [] });
            const r = await client.getSlashEvents(42, 'contract');
            expect(r.total).to.equal(1);
        });
    });

    /*
     *  Utility methods — additional
     */

    describe('utility methods', function () {
        it('getStatus returns result', async function () {
            nock(BASE).get('/BTC/api/status').reply(200, { status: 'ok' });
            const r = await client.getStatus();
            expect(r.status).to.equal('ok');
        });

        it('getMempool returns result', async function () {
            nock(BASE).get('/BTC/api/mempool/addr1/address').reply(200, { total: 1, data: [] });
            const r = await client.getMempool('addr1', 'address');
            expect(r.total).to.equal(1);
        });

        it('getNetwork returns result', async function () {
            nock(BASE).get('/BTC/api/network').reply(200, { height: 100 });
            const r = await client.getNetwork();
            expect(r.height).to.equal(100);
        });
    });

    /*
     *  gatedFile — getGatedFileRaw
     */

    describe('getGatedFileRaw', function () {
        it('returns Buffer from arraybuffer response', async function () {
            const fakeBytes = Buffer.from([0x01, 0x02, 0x03]);
            nock(BASE)
                .get('/BTC/api/file/42/raw')
                .reply(200, fakeBytes, { 'content-type': 'application/octet-stream' });

            const result = await client.getGatedFileRaw(42);
            expect(result).to.be.instanceof(Buffer);
        });

        it('fires onRequest/onResponse hooks for gatedFile', async function () {
            const onRequest = sinon.spy();
            const onResponse = sinon.spy();
            const hooked = new ExplorerClient({
                network: 'bitcoin-mainnet',
                explorerUrl: 'explorer.test',
                explorerPort: 8080,
                retry: false,
                hooks: { onRequest, onResponse }
            });
            const fakeBytes = Buffer.from([0xaa]);
            nock(BASE)
                .get('/BTC/api/file/99/raw')
                .reply(200, fakeBytes, { 'content-type': 'application/octet-stream' });

            await hooked.getGatedFileRaw(99);
            expect(onRequest.calledOnce).to.be.true;
            expect(onResponse.calledOnce).to.be.true;
        });

        it('fires onError hook for gatedFile error', async function () {
            const onError = sinon.spy();
            const hooked = new ExplorerClient({
                network: 'bitcoin-mainnet',
                explorerUrl: 'explorer.test',
                explorerPort: 8080,
                retry: false,
                hooks: { onError }
            });
            nock(BASE).get('/BTC/api/file/99/raw').reply(404, 'not found');
            try { await hooked.getGatedFileRaw(99); } catch (e) { /* expected */ }
            expect(onError.calledOnce).to.be.true;
        });
    });

    /*
     *  search — error handling path
     */

    describe('search error handling', function () {
        it('wraps HTTP error in search path', async function () {
            nock(BASE).get('/BTC/explorer/search/foo/token').reply(404, { error: 'not found' });
            try {
                await client.search('foo', 'token');
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.name).to.equal('SDKExplorerError');
                expect(e.code).to.equal('EXPLORER_HTTP_404');
            }
        });

        it('wraps network error in search path', async function () {
            nock(BASE).get('/BTC/explorer/search/foo/token').replyWithError('connection reset');
            try {
                await client.search('foo', 'token');
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.name).to.equal('SDKExplorerError');
                expect(e.code).to.equal('EXPLORER_NETWORK');
            }
        });

        it('fires onRequest/onResponse hooks in search', async function () {
            const onRequest = sinon.spy();
            const onResponse = sinon.spy();
            const hooked = new ExplorerClient({
                network: 'bitcoin-mainnet',
                explorerUrl: 'explorer.test',
                explorerPort: 8080,
                retry: false,
                hooks: { onRequest, onResponse }
            });
            nock(BASE).get('/BTC/explorer/search/foo/token').reply(200, { data: [] });
            await hooked.search('foo', 'token');
            expect(onRequest.calledOnce).to.be.true;
            expect(onResponse.calledOnce).to.be.true;
        });

        it('fires onError hook in search on failure', async function () {
            const onError = sinon.spy();
            const hooked = new ExplorerClient({
                network: 'bitcoin-mainnet',
                explorerUrl: 'explorer.test',
                explorerPort: 8080,
                retry: false,
                hooks: { onError }
            });
            nock(BASE).get('/BTC/explorer/search/foo/token').replyWithError('down');
            try { await hooked.search('foo', 'token'); } catch(e) {}
            expect(onError.calledOnce).to.be.true;
        });

        it('outer catch wraps retryable error that exhausted retries', async function () {
            // Use sinon to inject an ECONNRESET error so isRetryable=true but
            // retry:false means maxRetries=0, so it exhausts immediately and
            // reaches the outer catch -> _handleError
            const noRetry = new ExplorerClient({
                network: 'bitcoin-mainnet',
                explorerUrl: 'explorer.test',
                explorerPort: 8080,
                retry: false
            });
            const err = new Error('connection reset');
            err.code = 'ECONNRESET';
            sinon.stub(noRetry.client, 'get').rejects(err);
            try {
                await noRetry.search('foo', 'token');
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.name).to.equal('SDKExplorerError');
                expect(e.code).to.equal('EXPLORER_NETWORK');
            }
        });
    });

    /*
     *  _buildParams — additional params coverage
     */

    describe('_buildParams additional params', function () {
        it('passes start, length, tick, txid, blockIndex params', async function () {
            nock(BASE)
                .get('/BTC/api/balances/addr1')
                .query({ start: '0', length: '100', tick: 'TOKEN', txid: 'abc', blockIndex: '500' })
                .reply(200, { data: [] });
            const r = await client.getBalances('addr1', {
                start: 0, length: 100, tick: 'TOKEN', txid: 'abc', blockIndex: 500
            });
            expect(r).to.have.property('data');
        });
    });

    /*
     *  All public methods exist
     */

    describe('public methods', function () {
        const methods = [
            'getBalances', 'getAddress', 'getHolders', 'getCredits', 'getDebits', 'getEscrows',
            'getToken', 'getProject', 'getTokens', 'getIssues',
            'getTransaction', 'getAction', 'getBlock', 'getHistory',
            'getAddresses', 'getAirdrops', 'getBatches', 'getBroadcasts', 'getCallbacks',
            'getCoinpays', 'getCoinpayExpires', 'getCoinpayObligations',
            'getDestroys', 'getDispensers', 'getDispenses',
            'getDispenserCancels', 'getDispenserCloses', 'getDispenserExpires', 'getDispenserEdits',
            'getDividends', 'getFees',
            'getFiles', 'getLinks', 'getLists', 'getMessages', 'getMints', 'getOrders',
            'getOrderCancels', 'getOrderEdits', 'getOrderExpires', 'getOrderMatches',
            'getSends', 'getSleeps', 'getSwaps',
            'getSwapCancels', 'getSwapEdits', 'getSwapExpires', 'getSweeps',
            'getPrices', 'getPriceSnapshots',
            'getStakes', 'getDelegations', 'getValidators', 'getValidatorRewards',
            'getContractStakes', 'getContractUnstakes', 'getSlashEvents',
            'getXcalls', 'getXcall',
            'getMarkets', 'getMarket', 'getMarketHistory', 'getMarketOrders', 'getOrderbook',
            'getStatus', 'getMempool', 'getNetwork', 'search'
        ];
        for (let method of methods) {
            it('has ' + method + '()', function () {
                expect(client[method]).to.be.a('function');
            });
        }

        it('has 86 public methods', function () {
            let publicMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(client))
                .filter(m => !m.startsWith('_') && m !== 'constructor');
            expect(publicMethods).to.have.length(86);
        });
    });

});
