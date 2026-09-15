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
const Workflows = require('../../../src/actions/workflows.js');
const Actions = require('../../../src/actions/index.js');
const Utility = require('../../../src/utils/utility.js');
const config = require('../../../src/config.js');

const FAKE_WIF = 'L1rkA9mYRjVPVdvMuVbHRMX6SPHM7fNwCEfT3AV2qCGAmJ8wNfp';

// Tests

//  deployContract() - chunked assembler pre-flight
//
//  planDeploy sizes only the INLINE DEPLOY. Without a Phase-2 pre-flight an
//  oversized constructor param is only discovered AFTER every paid v4
//  carrier is on chain, so the fees are spent on a deploy that can never
//  assemble. These pin the pre-flight to the exact composed assembler.
// Fake SDK carrying a REAL Actions instance, because the pre-flight
// measures the canonical composed action string, not an estimate.
function makeChunkSdk(calls) {
    const session = {
        deployChunk: async (p) => { calls.chunks.push(p); return { txid: 'chunk_tx' }; },
        deploy:      async (p) => { calls.deploys.push(p); return { txid: 'deploy_tx', indexed: { action_index: 99 } }; },
    };
    return {
        actions: new Actions({ config: config.getConfig(), util: new Utility() }),
        session: () => session,
        // The chunked path resolves the contract through the explorer, so the
        // fake has to answer an action detail: this one is the sequential case
        // (the group was complete at the assembler, contract index = A).
        getAction: async () => ({ data: [{ action_index: 99, deployed_contract_index: 99, assembly_status: 'valid' }] }),
        _preflightContractLint: () => {},
    };
}

describe('Workflows', function () {

    afterEach(() => sinon.restore());

    describe('deployContract() chunked assembler pre-flight', function () {
        it('rejects an over-cap assembler BEFORE broadcasting any carrier', async function () {
            const calls = { chunks: [], deploys: [] };
            const wf = new Workflows(makeChunkSdk(calls));
            let err;
            try {
                await wf.deployContract(FAKE_WIF, {
                    code: 'x'.repeat(7000),
                    gasLimit: 100000,
                    constructorParams: ['y'.repeat(8200)],
                });
            } catch (e) { err = e; }
            assert.ok(err, 'an assembler over MAX_ACTION_DATA_LENGTH must throw');
            assert.match(err.message, /exceeds MAX_ACTION_DATA_LENGTH/);
            assert.strictEqual(calls.chunks.length, 0, 'no carrier fee may be spent on an undeployable plan');
            assert.strictEqual(calls.deploys.length, 0);
        });
    });
});

describe('Workflows', function () {

    afterEach(() => sinon.restore());

    describe('deployContract() chunked assembler pre-flight', function () {
        it('still runs a normal chunked deploy whose assembler fits', async function () {
            const calls = { chunks: [], deploys: [] };
            const wf = new Workflows(makeChunkSdk(calls));
            const out = await wf.deployContract(FAKE_WIF, {
                code: 'x'.repeat(20000),
                gasLimit: 100000,
                constructorParams: ['a'],
            });
            assert.ok(calls.chunks.length > 1, 'should carry the source in ordered slices');
            assert.strictEqual(calls.deploys.length, 1);
            assert.strictEqual(calls.deploys[0].version, '2');
            assert.strictEqual(out.deploy.txid, 'deploy_tx');
        });
    });
});

describe('Workflows', function () {

    afterEach(() => sinon.restore());

    describe('deployContract() chunked assembler pre-flight', function () {
        it('pre-flights the v3 (staking) assembler on the same path', async function () {
            const calls = { chunks: [], deploys: [] };
            const wf = new Workflows(makeChunkSdk(calls));
            await wf.deployContract(FAKE_WIF, {
                code: 'x'.repeat(20000),
                gasLimit: 100000,
                constructorParams: ['a'],
                cooldownBlocks: 100,
                slashDestination: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
            });
            assert.strictEqual(calls.deploys[0].version, '3');
            assert.strictEqual(calls.deploys[0].cooldownBlocks, 100);
        });
    });
});

describe('Workflows', function () {

    afterEach(() => sinon.restore());

    describe('deployContract() chunked assembler pre-flight', function () {
        // A slashDestination with no cooldownBlocks is a config the INLINE deploy
        // refuses (validator: 'SLASH_DESTINATION requires COOLDOWN_BLOCKS', the same
        // rule the indexer applies). The chunked path must refuse it too: a staking
        // gate that reads cooldownBlocks alone drops the destination out of the
        // assembler params and deploys the contract as a non-stakeable v2, with no
        // refusal at all. Source size may not decide whether a staking config is
        // legal, and the refusal has to land before any carrier fee is spent.
        it('refuses a slashDestination with no cooldown, as the inline path does', async function () {
            const calls = { chunks: [], deploys: [] };
            const wf = new Workflows(makeChunkSdk(calls));
            let err;
            try {
                await wf.deployContract(FAKE_WIF, {
                    code: 'x'.repeat(20000),
                    gasLimit: 100000,
                    slashDestination: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
                });
            } catch (e) { err = e; }
            assert.ok(err, 'a chunked deploy must refuse the config the inline deploy refuses');
            assert.match(err.message, /SLASH_DESTINATION requires COOLDOWN_BLOCKS/);
            assert.strictEqual(calls.chunks.length, 0, 'no carrier fee may be spent on a config that cannot deploy');
            assert.strictEqual(calls.deploys.length, 0);
        });
    });
});
