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

const FAKE_WIF = 'L1rkA9mYRjVPVdvMuVbHRMX6SPHM7fNwCEfT3AV2qCGAmJ8wNfp';

// Tests

// resolveDeployedContract()
//
// A chunk group deploys at whichever piece completes it, so the assembler's own
// row does not name the contract. These pin the poll against the explorer's
// reported pair (deployed_contract_index / assembly_status), including the two
// ways it can end without a contract and the older explorer that reports neither.
// Answers each queued explorer detail in turn, repeating the last one, and
// records how many GETs the poll actually made.
function makeExplorerSdk(details) {
    const state = { calls: [], sdk: null };
    state.sdk = {
        session:   () => ({}),
        getAction: async (actionIndex) => {
            state.calls.push(actionIndex);
            const d = details[Math.min(state.calls.length - 1, details.length - 1)];
            return (typeof d === 'function') ? d() : d;
        },
    };
    return state;
}

const FAST = { timeout: 2000, pollInterval: 1 };

describe('Workflows', function () {

    afterEach(() => sinon.restore());

    describe('resolveDeployedContract()', function () {
        it('answers the assembler index in one GET when the group deployed there (R2.1)', async function () {
            const state = makeExplorerSdk([{ data: [{ action_index: 1378, deployed_contract_index: 1378, assembly_status: 'valid' }] }]);
            const wf = new Workflows(state.sdk);
            const index = await wf.resolveDeployedContract(1378, FAST);
            assert.strictEqual(index, 1378);
            assert.deepStrictEqual(state.calls, [1378], 'the sequential case must cost exactly one explorer read');
        });

        it('answers the completing carrier index after the group stops pending', async function () {
            const pending = { data: [{ action_index: 1419, deployed_contract_index: null, assembly_status: 'pending: CODE_HASH (awaiting chunks)' }] };
            const done    = { data: [{ action_index: 1419, deployed_contract_index: 1421, assembly_status: 'valid' }] };
            const state = makeExplorerSdk([pending, pending, pending, done]);
            const wf = new Workflows(state.sdk);
            const index = await wf.resolveDeployedContract(1419, FAST);
            assert.strictEqual(index, 1421, 'the contract lives at the carrier that completed the group, not at the assembler');
            assert.strictEqual(state.calls.length, 4);
        });

        it('rejects with the reported status when the group settled without a contract', async function () {
            // A hash mismatch at the completing carrier consumes the assembler: nothing
            // retries it, so a client that kept polling would wait out the whole timeout.
            const state = makeExplorerSdk([{ data: [{ action_index: 1430, deployed_contract_index: null, assembly_status: 'invalid: CODE_HASH (hash mismatch)' }] }]);
            const wf = new Workflows(state.sdk);
            let err;
            try { await wf.resolveDeployedContract(1430, FAST); } catch (e) { err = e; }
            assert.ok(err, 'a settled non-pending status with no contract must reject');
            assert.ok(err.message.indexOf('invalid: CODE_HASH (hash mismatch)') !== -1,
                'the reported status must ride in the message: ' + err.message);
            assert.strictEqual(err.status, 'invalid: CODE_HASH (hash mismatch)');
            assert.strictEqual(err.actionIndex, 1430);
            assert.strictEqual(state.calls.length, 1, 'a terminal verdict must not be re-polled');
        });

        it('falls back to the assembler index when the explorer carries neither field and the action is valid', async function () {
            // An explorer from before the field landed. A valid assembler is a group
            // that completed at A, which is the only case such an explorer can answer.
            const state = makeExplorerSdk([{ data: [{ action_index: 287, status: 'valid' }] }]);
            const wf = new Workflows(state.sdk);
            assert.strictEqual(await wf.resolveDeployedContract(287, FAST), 287);
            assert.strictEqual(state.calls.length, 1);
        });
    });
});

describe('Workflows', function () {

    afterEach(() => sinon.restore());

    describe('resolveDeployedContract()', function () {
        it('rejects an invalid assembler when the explorer carries neither field', async function () {
            const state = makeExplorerSdk([{ data: [{ action_index: 70, status: 'invalid: CODE_HASH (no chunks)' }] }]);
            const wf = new Workflows(state.sdk);
            let err;
            try { await wf.resolveDeployedContract(70, FAST); } catch (e) { err = e; }
            assert.ok(err);
            assert.ok(err.message.indexOf('invalid: CODE_HASH (no chunks)') !== -1, err.message);
            assert.strictEqual(err.status, 'invalid: CODE_HASH (no chunks)');
        });

        it('times out, naming the missing field, when the explorer carries neither field and the action is pending', async function () {
            const state = makeExplorerSdk([{ data: [{ action_index: 1419, status: 'pending: CODE_HASH (awaiting chunks)' }] }]);
            const wf = new Workflows(state.sdk);
            let err;
            try { await wf.resolveDeployedContract(1419, { timeout: 30, pollInterval: 5 }); } catch (e) { err = e; }
            assert.ok(err, 'an explorer that never reports the field must not hang forever');
            assert.ok(err.message.indexOf('deployed_contract_index') !== -1,
                'the timeout must name the field the explorer never exposed: ' + err.message);
            assert.strictEqual(err.actionIndex, 1419);
            assert.ok(state.calls.length > 1, 'it should have polled more than once before the deadline');
        });

        it('unwraps the bare-object and nested-action envelopes too', async function () {
            const bare   = makeExplorerSdk([{ action_index: 5, deployed_contract_index: 9, assembly_status: 'valid' }]);
            const nested = makeExplorerSdk([{ data: { action: { action_index: 5, deployed_contract_index: 11, assembly_status: 'valid' } } }]);
            assert.strictEqual(await new Workflows(bare.sdk).resolveDeployedContract(5, FAST), 9);
            assert.strictEqual(await new Workflows(nested.sdk).resolveDeployedContract(5, FAST), 11);
        });

        it('refuses to poll without an assembler action_index', async function () {
            const state = makeExplorerSdk([{}]);
            const wf = new Workflows(state.sdk);
            await assert.rejects(() => wf.resolveDeployedContract(null, FAST), /action_index is required/);
            assert.strictEqual(state.calls.length, 0);
        });
    });
});
