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

// Helpers

/**
 * Build a minimal fake SDK whose sdk.session() returns a stubbed WalletSession.
 * `sessionMethods` lets individual tests override what each session method returns.
 */
function makeSdk(sessionMethods = {}) {
    const defaults = {
        issue:             async () => ({ txid: 'issue_tx', indexed: { action_index: 42 } }),
        mint:              async () => ({ txid: 'mint_tx' }),
        send:              async () => ({ txid: 'send_tx' }),
        dispenser:         async () => ({ txid: 'dispenser_tx' }),
        order:             async () => ({ txid: 'order_tx' }),
        stake:             async () => ({ txid: 'stake_tx' }),
        delegate:          async () => ({ txid: 'delegate_tx' }),
        stakeToContract:   async () => ({ txid: 'stake_contract_tx' }),
        delegateForContract: async () => ({ txid: 'delegate_contract_tx' }),
        deploy:            async () => ({ txid: 'deploy_tx', indexed: { action_index: 99 } }),
        deposit:           async () => ({ txid: 'deposit_tx' }),
        dividend:          async () => ({ txid: 'dividend_tx' }),
    };
    const sessionFns = Object.assign({}, defaults, sessionMethods);
    return {
        session: () => sessionFns,
        // The explorer read the chunked-deploy resolution polls. Answers the
        // sequential shape (the assembler's own index) unless a test overrides it.
        getAction: async (actionIndex) => ({ data: [{ action_index: actionIndex, deployed_contract_index: actionIndex, assembly_status: 'valid' }] }),
    };
}

const FAKE_WIF = 'L1rkA9mYRjVPVdvMuVbHRMX6SPHM7fNwCEfT3AV2qCGAmJ8wNfp';
const FAKE_TICK = 'TOKEN';

// Tests

describe('Workflows', function () {

    afterEach(() => sinon.restore());

    // deployStakeableContract()
    describe('deployStakeableContract()', function () {
        it('delegates to deployAndFund with VERSION forced to "1"', async function () {
            const deployAndFundCalls = [];
            // Spy on deployAndFund
            const sdk = makeSdk();
            const wf = new Workflows(sdk);
            const origDeployAndFund = wf.deployAndFund.bind(wf);
            wf.deployAndFund = async (wif, params, deposits, opts) => {
                deployAndFundCalls.push({ wif, params, deposits, opts });
                return origDeployAndFund(wif, params, deposits, opts);
            };

            const result = await wf.deployStakeableContract(
                FAKE_WIF,
                { code: 'contract', COOLDOWN_BLOCKS: 100, SLASH_DESTINATION: 'BURN' },
                [{ tick: 'A', quantity: '10' }]
            );
            assert.strictEqual(deployAndFundCalls[0].params.VERSION, '1');
            assert.strictEqual(deployAndFundCalls[0].params.COOLDOWN_BLOCKS, 100);
            assert.strictEqual(deployAndFundCalls[0].params.SLASH_DESTINATION, 'BURN');
        });

        it('throws when COOLDOWN_BLOCKS is missing', async function () {
            const wf = new Workflows(makeSdk());
            await assert.rejects(
                () => wf.deployStakeableContract(FAKE_WIF, { SLASH_DESTINATION: 'BURN' }, []),
                /COOLDOWN_BLOCKS is required/
            );
        });
    });
});

describe('Workflows', function () {

    afterEach(() => sinon.restore());

    describe('deployStakeableContract()', function () {
        it('throws when COOLDOWN_BLOCKS is null', async function () {
            const wf = new Workflows(makeSdk());
            await assert.rejects(
                () => wf.deployStakeableContract(FAKE_WIF, { COOLDOWN_BLOCKS: null, SLASH_DESTINATION: 'BURN' }, []),
                /COOLDOWN_BLOCKS is required/
            );
        });

        it('throws when COOLDOWN_BLOCKS is empty string', async function () {
            const wf = new Workflows(makeSdk());
            await assert.rejects(
                () => wf.deployStakeableContract(FAKE_WIF, { COOLDOWN_BLOCKS: '', SLASH_DESTINATION: 'BURN' }, []),
                /COOLDOWN_BLOCKS is required/
            );
        });

        it('throws when SLASH_DESTINATION is missing', async function () {
            const wf = new Workflows(makeSdk());
            await assert.rejects(
                () => wf.deployStakeableContract(FAKE_WIF, { COOLDOWN_BLOCKS: 100 }, []),
                /SLASH_DESTINATION is required/
            );
        });

        it('throws when deployParams is null', async function () {
            const wf = new Workflows(makeSdk());
            await assert.rejects(
                () => wf.deployStakeableContract(FAKE_WIF, null, []),
                /COOLDOWN_BLOCKS is required/
            );
        });
    });
});
