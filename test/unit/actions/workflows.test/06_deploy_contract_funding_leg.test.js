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

// deployContract()'s funding leg had no coverage at all, which is how it kept
// the same direct read of indexed.action_index that deployAndFund had.
function makeDepositSdk(calls, indexed) {
    const session = {
        deployChunk: async () => ({ txid: 'chunk_tx' }),
        deploy:      async () => ({ txid: 'deploy_tx', indexed }),
        deposit:     async (p) => { calls.push(p); return { txid: 'deposit_tx' }; },
    };
    return {
        actions: new Actions({ config: config.getConfig(), util: new Utility() }),
        session: () => session,
        preflightContractLint: () => {},
    };
}

describe('Workflows', function () {

    afterEach(() => sinon.restore());

    describe('deployContract() funding leg', function () {
        it('funds from the polling waiter shape ({ actions: [...] })', async function () {
            const calls = [];
            const wf = new Workflows(makeDepositSdk(calls, { actions: [{ action_index: 7 }] }));
            const out = await wf.deployContract(FAKE_WIF, { code: 'x', gasLimit: 1 },
                [{ tick: 'TOK', quantity: '5' }]);
            assert.strictEqual(out.deposits.length, 1);
            assert.strictEqual(calls[0].contractActionIndex, 7);
        });

        it('funds on action_index 0', async function () {
            const calls = [];
            const wf = new Workflows(makeDepositSdk(calls, { action_index: 0 }));
            await wf.deployContract(FAKE_WIF, { code: 'x', gasLimit: 1 }, [{ tick: 'TOK', quantity: '5' }]);
            assert.strictEqual(calls[0].contractActionIndex, 0);
        });

        it('refuses to fund with no resolvable index, keeping the broadcast deploy', async function () {
            const calls = [];
            const wf = new Workflows(makeDepositSdk(calls, null));
            let err;
            try {
                await wf.deployContract(FAKE_WIF, { code: 'x', gasLimit: 1 }, [{ tick: 'TOK', quantity: '5' }]);
            } catch (e) { err = e; }
            assert.ok(err);
            assert.match(err.message, /deployContract: DEPLOY action_index unavailable/);
            assert.strictEqual(calls.length, 0, 'no DEPOSIT may go out without a contract reference');
            assert.strictEqual(err.partial.deploy.txid, 'deploy_tx');
        });
    });
});
