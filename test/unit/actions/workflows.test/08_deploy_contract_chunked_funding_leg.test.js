// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('assert');
const sinon = require('sinon');
const Workflows = require('../../../../src/actions/workflows.js');
const Actions = require('../../../../src/actions/index.js');
const Utility = require('../../../../src/utils/utility.js');
const config = require('../../../../src/config.js');

const FAKE_WIF = 'L1rkA9mYRjVPVdvMuVbHRMX6SPHM7fNwCEfT3AV2qCGAmJ8wNfp';

// Tests

describe('Workflows', function () {

    afterEach(() => sinon.restore());

    // The chunked deploy's funding leg must fund the contract that was actually
    // deployed, which after a reorder is a carrier's index and not the assembler's.
    describe('deployContract() chunked funding leg', function () {
        it('deposits against the resolved contract index, not the assembler index', async function () {
            const deposited = [];
            const session = {
                deployChunk: async () => ({ txid: 'chunk_tx' }),
                deploy:      async () => ({ txid: 'deploy_tx', indexed: { action_index: 1419 } }),
                deposit:     async (p) => { deposited.push(p); return { txid: 'deposit_tx' }; },
            };
            const sdk = {
                actions: new Actions({ config: config.getConfig(), util: new Utility() }),
                session: () => session,
                getAction: async () => ({ data: [{ action_index: 1419, deployed_contract_index: 1421, assembly_status: 'valid' }] }),
                preflightContractLint: () => {},
            };
            const wf = new Workflows(sdk);
            const out = await wf.deployContract(FAKE_WIF, { code: 'x'.repeat(20000), gasLimit: 100000 },
                [{ tick: 'TOK', quantity: '5' }], { pollInterval: 1 });
            assert.strictEqual(out.contractActionIndex, 1421);
            assert.strictEqual(deposited.length, 1);
            assert.strictEqual(deposited[0].contractActionIndex, 1421,
                'a DEPOSIT sent to the assembler index would fund nothing');
        });

        it('carries the single-shot contract index on the result without an explorer read', async function () {
            let reads = 0;
            const session = {
                deploy:  async () => ({ txid: 'deploy_tx', indexed: { action_index: 7 } }),
                deposit: async () => ({ txid: 'deposit_tx' }),
            };
            const sdk = {
                actions: new Actions({ config: config.getConfig(), util: new Utility() }),
                session: () => session,
                getAction: async () => { reads++; return null; },
                preflightContractLint: () => {},
            };
            const out = await new Workflows(sdk).deployContract(FAKE_WIF, { code: 'x', gasLimit: 1 });
            assert.strictEqual(out.contractActionIndex, 7);
            assert.strictEqual(reads, 0, 'an inline deploy is its own contract; nothing to resolve');
        });
    });
});
