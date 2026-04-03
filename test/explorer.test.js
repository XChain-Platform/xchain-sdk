const { expect } = require('chai');
const nock = require('nock');
const ExplorerClient = require('../src/explorer.js');

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
     *  All public methods exist
     */

    describe('public methods', function () {
        const methods = [
            'getBalances', 'getAddress', 'getHolders', 'getCredits', 'getDebits', 'getEscrows',
            'getToken', 'getTokens', 'getIssues',
            'getTransaction', 'getAction', 'getBlock', 'getHistory',
            'getAddresses', 'getAirdrops', 'getBatches', 'getBroadcasts', 'getCallbacks',
            'getDestroys', 'getDispensers', 'getDispenses', 'getDividends', 'getFees',
            'getFiles', 'getLinks', 'getLists', 'getMessages', 'getMints', 'getOrders',
            'getSends', 'getSleeps', 'getSwaps', 'getSweeps',
            'getMarkets', 'getMarket', 'getMarketHistory', 'getMarketOrders', 'getOrderbook',
            'getStatus', 'search'
        ];
        for (let method of methods) {
            it('has ' + method + '()', function () {
                expect(client[method]).to.be.a('function');
            });
        }

        it('has 48 public methods', function () {
            let publicMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(client))
                .filter(m => !m.startsWith('_') && m !== 'constructor');
            expect(publicMethods).to.have.length(48);
        });
    });

});
