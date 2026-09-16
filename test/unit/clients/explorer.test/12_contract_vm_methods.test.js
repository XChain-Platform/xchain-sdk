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
    });
});

describe('ExplorerClient', function () {
    beforeEach(resetClient);
    afterEach(cleanNock);

    describe('contract/VM methods', function () {

        it('getExecutions with a query builds the filtered {query}/{type} path (default contract)', async function () {
            nock(BASE).get('/BTC/api/executions/42/contract').reply(200, { total: 5, data: [] });
            const r = await client.getExecutions(42);
            expect(r.total).to.equal(5);
        });

        it('getExecutions without contractActionIndex returns result', async function () {
            nock(BASE).get('/BTC/api/executions').reply(200, { total: 0, data: [] });
            const r = await client.getExecutions(null);
            expect(r.total).to.equal(0);
        });

        it('getContracts/getExecutions answer the list ENVELOPE, and index.d.ts says so', async function () {
            // The explorer's datatable routes answer { data, total, runtime } and the SDK
            // passes it through. An earlier index.d.ts declared a bare array, so a TS caller
            // wrote .map() on the envelope and threw at runtime. Pin both halves: the wire
            // shape, and the declaration that is supposed to describe it.
            nock(BASE).get('/BTC/api/contracts').reply(200, { total: 1, data: [{ action_index: 7 }], runtime: '3ms' });
            const contracts = await client.getContracts(null, 'address');
            expect(contracts).to.have.property('data').that.is.an('array');
            expect(contracts).to.have.property('total');
            expect(Array.isArray(contracts)).to.equal(false);

            nock(BASE).get('/BTC/api/executions').reply(200, { total: 2, data: [{ method: 'run' }], runtime: '1ms' });
            const executions = await client.getExecutions(null);
            expect(executions).to.have.property('data').that.is.an('array');
            expect(Array.isArray(executions)).to.equal(false);

            const dts = require('fs').readFileSync(require('path').join(__dirname, '../../../../index.d.ts'), 'utf8');
            expect(dts, 'ListEnvelope must be declared').to.match(/export interface ListEnvelope<T> \{/);
            expect(dts).to.match(/getContracts\(query\?: string, type\?: string, opts\?: QueryOptions\): Promise<ListEnvelope<ContractInfo>>;/);
            // Three-arg, matching the implementation: a two-arg declaration here is
            // what taught callers to put opts in the type slot (mcp get_executions).
            expect(dts).to.match(/getExecutions\(query\?: number \| string, type\?: string, opts\?: QueryOptions\): Promise<ListEnvelope<ExecutionInfo>>;/);
            expect(dts, 'the ContractClient mirror delegates straight through').to.match(/getExecutions\(opts\?: QueryOptions\): Promise<ListEnvelope<ExecutionInfo>>;/);
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
});
