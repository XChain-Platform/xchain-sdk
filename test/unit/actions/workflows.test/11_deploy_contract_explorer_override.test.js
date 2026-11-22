// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const assert = require('assert');
const Actions = require('../../../../src/actions/index.js');
const Workflows = require('../../../../src/actions/workflows.js');
const Utility = require('../../../../src/utils/utility.js');
const config = require('../../../../src/config.js');

const FAKE_WIF = 'L1rkA9mYRjVPVdvMuVbHRMX6SPHM7fNwCEfT3AV2qCGAmJ8wNfp';

function deploySdk(defaultIndex, overrideIndex, deposited) {
    const reads = { default: 0, override: 0 };
    const session = {
        deployChunk: async () => ({ txid: 'chunk_tx' }),
        deploy: async () => ({ txid: 'deploy_tx', indexed: { action_index: 1419 } }),
        deposit: async (params) => { deposited.push(params); return { txid: 'deposit_tx' }; },
    };
    const sdk = {
        actions: new Actions({ config: config.getConfig(), util: new Utility() }),
        session: () => session,
        getAction: async () => {
            reads.default++;
            return { data: [{ deployed_contract_index: defaultIndex, assembly_status: 'valid' }] };
        },
        preflightContractLint: () => {},
    };
    const explorer = {
        getAction: async () => {
            reads.override++;
            return { data: [{ deployed_contract_index: overrideIndex, assembly_status: 'valid' }] };
        },
    };
    return { sdk, explorer, reads };
}

describe('Workflows: chunked deploy explorer override', function () {
    it('funds the contract reported by the per-call explorer', async function () {
        const deposited = [];
        const state = deploySdk(999, 123, deposited);
        const out = await new Workflows(state.sdk).deployContract(FAKE_WIF,
            { code: 'x'.repeat(20000), gasLimit: 100000 },
            [{ tick: 'TOK', quantity: '5' }],
            { explorer: state.explorer, pollInterval: 1 });
        assert.strictEqual(out.contractActionIndex, 123);
        assert.strictEqual(deposited[0].contractActionIndex, 123);
        assert.strictEqual(state.reads.default, 0);
        assert.strictEqual(state.reads.override, 1);
    });

    it('uses the override for every deployment-detail poll', async function () {
        let overrideReads = 0;
        let defaultReads = 0;
        const sdk = { getAction: async () => { defaultReads++; return null; } };
        const explorer = { getAction: async () => {
            overrideReads++;
            return { data: [{ deployed_contract_index: overrideReads === 1 ? null : 88,
                assembly_status: overrideReads === 1 ? 'pending' : 'valid' }] };
        } };
        const index = await new Workflows(sdk).resolveDeployedContract(7,
            { explorer, timeout: 2000, pollInterval: 1 });
        assert.strictEqual(index, 88);
        assert.strictEqual(overrideReads, 2);
        assert.strictEqual(defaultReads, 0);
    });

    it('keeps the SDK explorer as the no-override fallback', async function () {
        let reads = 0;
        const sdk = { getAction: async () => {
            reads++;
            return { data: [{ deployed_contract_index: 44, assembly_status: 'valid' }] };
        } };
        assert.strictEqual(await new Workflows(sdk).resolveDeployedContract(7,
            { timeout: 2000, pollInterval: 1 }), 44);
        assert.strictEqual(reads, 1);
    });
});
