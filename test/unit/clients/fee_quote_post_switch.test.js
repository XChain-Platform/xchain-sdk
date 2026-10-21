'use strict';

const { expect } = require('chai');
const nock = require('nock');
const ExplorerClient = require('../../../src/clients/explorer.js');

describe('getFeeQuote POST switch', function () {
    const BASE = 'http://explorer.test:8080';
    let client;
    const big = 'A'.repeat(7000);

    beforeEach(function () {
        client = new ExplorerClient({ network: 'bitcoin-regtest', explorerUrl: 'explorer.test', explorerPort: 8080, retry: false });
    });
    afterEach(function () { nock.cleanAll(); });

    it('keeps GET for a short query', async function () {
        nock(BASE).get('/RBTC/api/feequote').query({ action: 'ISSUE', params: '0|X' }).reply(200, { valid: true });
        expect((await client.getFeeQuote({ action: 'ISSUE', params: '0|X' })).valid).to.equal(true);
    });

    it('POSTs a JSON body once the query passes 6144 characters', async function () {
        let seen;
        nock(BASE).post('/RBTC/api/feequote', (b) => { seen = b; return true; }).reply(200, { valid: true });
        let q = await client.getFeeQuote({ action: 'BATCH', params: big, source: 's' });
        expect(q.valid).to.equal(true);
        expect(seen).to.deep.equal({ action: 'BATCH', params: big, source: 's' });
    });

    for (const code of [404, 405]) {
        it('retries GET once on a ' + code + ' from POST', async function () {
            nock(BASE).post('/RBTC/api/feequote').reply(code, {});
            nock(BASE).get('/RBTC/api/feequote').query(true).reply(200, { valid: true, via: 'get' });
            expect((await client.getFeeQuote({ action: 'BATCH', params: big })).via).to.equal('get');
        });
    }

    it('does not fall back on other statuses', async function () {
        nock(BASE).post('/RBTC/api/feequote').reply(400, {});
        let err;
        try { await client.getFeeQuote({ action: 'BATCH', params: big }); } catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.details.status).to.equal(400);
    });
});
