/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Platform SDK - Wire-Index Identity Above 2^53
 *
 * The explorer serializes BIGINT columns (action_index, block_index,
 * tx_index) as decimal STRINGS, and Number() collapses two ADJACENT such
 * values above 2^53 onto one. Every guard that decides "is this the index
 * the caller asked for" was written with Number(), so it matched the
 * neighbour it exists to reject:
 *
 *   - light.verifyAction's ACTION_INDEX_MISMATCH is the ONLY check binding a
 *     served merkle proof to the caller's query (verifyActionProof recomputes
 *     the leaf FROM proof.action_index, so it cannot back it up). Collapsed,
 *     a genuine proof for action N+1 verified clean for a query about N.
 *   - ActionWaiter's targeted wait filtered the poll rows and the NEW_ACTION
 *     fast path the same way, so a neighbouring action's status settled the
 *     wait and masked the target action's rejection.
 *
 * Each case below is written so it PASSED (wrongly) before the fix.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const M = require('../../src/merkle.js');
const light = require('../../src/light.js');
const ActionWaiter = require('../../src/actionWaiter.js');
const { sameWireIndex, toWireIndex } = require('../../src/utils/wireIndex.js');

// Two adjacent indices that JavaScript's Number cannot tell apart, spelled the
// way the wire spells them.
const N     = '9007199254740992';        // 2^53
const N_1   = '9007199254740993';        // 2^53 + 1
const CHAIN = 'BTC';
const NET   = 'regtest';

describe('wireIndex: exact identity for BIGINT-as-string wire indices', function () {

    it('the premise: Number() cannot separate two adjacent indices above 2^53', function () {
        assert.strictEqual(Number(N) === Number(N_1), true, 'control for the guards below');
    });

    it('sameWireIndex separates them', function () {
        assert.strictEqual(sameWireIndex(N, N_1), false);
        assert.strictEqual(sameWireIndex(N, N), true);
    });

    it('keeps the string/number coercion callers relied on Number() for', function () {
        assert.strictEqual(sameWireIndex('2', 2), true);
        assert.strictEqual(sameWireIndex(' 011 ', 11), true);
    });

    it('fails closed on a value that is not a usable index', function () {
        // A null coerced through Number() would MATCH index 0, and an unsafe
        // number has already lost its precision upstream, so neither is an index.
        assert.strictEqual(sameWireIndex(null, 0), false);
        assert.strictEqual(sameWireIndex(undefined, 0), false);
        assert.strictEqual(sameWireIndex('100abc', 100), false);
        assert.strictEqual(sameWireIndex(9007199254740993, N_1), false);
        assert.strictEqual(toWireIndex(-1), null);
    });
});

// #5250: the proof-binding guard in light.verifyAction.
describe('light.verifyAction binds the proof to the caller query above 2^53', function () {

    // A §5 action inclusion proof for the SECOND action row, mirroring
    // light.test.js's buildActionProof but with the two action indices spelled
    // as the adjacent >2^53 decimal strings the explorer actually serves.
    function buildNeighbourProof() {
        const rows = {
            block_index: 200,
            ledger: { credits: [], debits: [], escrows: [] },
            actions: [{ action_index: N,   tx_index: '4000', action: 'ISSUE' },
                      { action_index: N_1, tx_index: '4000', action: 'SEND' }],
            contracts: { contracts: [], state: [], executions: [], emissions: [],
                         deposits: [], withdrawals: [] }
        };
        const leaves = M.blockMerkleLeaves(rows);
        const pos = 1;                                   // the N+1 row
        const row = rows.actions[pos];
        const mp = M.fixedMerkleProof(leaves, pos);      // no ledger leaves, so leafIndex === pos
        return {
            proof: {
                chain: CHAIN, network: NET, height: '200',
                action_index: row.action_index, tx_index: row.tx_index, action: row.action,
                leaf: M.toHex(M.actionsLeaf(row)),
                merkle_proof: { index: mp.index, siblings: mp.siblings },
                block_merkle_root: M.toHex(M.blockMerkleRoot(leaves)), block_merkle_version: 1
            },
            blockMerkleRoot: M.toHex(M.blockMerkleRoot(leaves))
        };
    }

    function servedBy(proof, blockMerkleRoot) {
        // trustedCheckpoint path: quorum is already established, so the run reaches
        // the binding guards without a validator-set fetch.
        const cp = { chain: CHAIN, network: NET, block_index: '200',
                     block_merkle_root: blockMerkleRoot };
        const fetchImpl = async () => ({ ok: true, status: 200,
                                         json: async () => ({ proof, checkpoint: cp }) });
        return { cp, fetchImpl };
    }

    it('control: the proof verifies for the index it is actually FOR', async function () {
        const { proof, blockMerkleRoot } = buildNeighbourProof();
        const { cp, fetchImpl } = servedBy(proof, blockMerkleRoot);
        const r = await light.verifyAction({ explorerUrl: 'https://x', coin: 'BTC',
            actionIndex: N_1, trustedCheckpoint: cp, fetchImpl });
        assert.strictEqual(r.verified, true, r.reason);
    });

    it('REFUSES a genuine proof for the NEIGHBOURING action index', async function () {
        // Pre-fix this returned verified:true: the guard collapsed both indices to
        // the same Number, and the merkle check re-derives the leaf from the
        // proof's own action_index, so it confirmed the WRONG action happily.
        const { proof, blockMerkleRoot } = buildNeighbourProof();
        const { cp, fetchImpl } = servedBy(proof, blockMerkleRoot);
        const r = await light.verifyAction({ explorerUrl: 'https://x', coin: 'BTC',
            actionIndex: N, trustedCheckpoint: cp, fetchImpl });
        assert.strictEqual(r.verified, false);
        assert.strictEqual(r.reason, 'ACTION_INDEX_MISMATCH');
    });

    it('REFUSES a proof relabelled onto a neighbouring checkpoint height', async function () {
        const { proof, blockMerkleRoot } = buildNeighbourProof();
        proof.height = N_1;
        const cp = { chain: CHAIN, network: NET, block_index: N,
                     block_merkle_root: blockMerkleRoot };
        const fetchImpl = async () => ({ ok: true, status: 200,
                                         json: async () => ({ proof, checkpoint: cp }) });
        const r = await light.verifyAction({ explorerUrl: 'https://x', coin: 'BTC',
            actionIndex: N_1, trustedCheckpoint: cp, fetchImpl });
        assert.strictEqual(r.verified, false);
        assert.strictEqual(r.reason, 'PROOF_HEIGHT_MISMATCH');
    });
});

// #5249: the targeted-wait filters in ActionWaiter.
describe('ActionWaiter targeted wait excludes the >2^53 neighbour', function () {

    const TXID = 'dd'.repeat(32);

    it('poll path: a neighbouring action rejection does not settle the wait', async function () {
        // Only action N+1 is in the transaction and it is INVALID; the caller waits
        // on N. Pre-fix the filter matched N+1 and rejected with a rejection that
        // was never the target action's.
        const sdk = { ws: null, _requireExplorer: () => ({ getTransaction: async () => ({
            tx_hash: TXID,
            actions: [{ action: 'SEND', action_index: N_1, status: 'invalid: neighbour' }],
        }) }) };
        const waiter = new ActionWaiter(sdk);
        await assert.rejects(
            () => waiter.waitForTxid(TXID, { timeout: 1200, pollInterval: 50, actionIndex: N }),
            (err) => err.code === 'CONFIRMATION_TIMEOUT');
    });

    it('poll path: the target action still settles the wait', async function () {
        const sdk = { ws: null, _requireExplorer: () => ({ getTransaction: async () => ({
            tx_hash: TXID,
            actions: [{ action: 'SEND', action_index: N_1, status: 'valid' },
                      { action: 'SEND', action_index: N,   status: 'invalid: mine' }],
        }) }) };
        const waiter = new ActionWaiter(sdk);
        await assert.rejects(
            () => waiter.waitForTxid(TXID, { timeout: 2000, pollInterval: 50, actionIndex: N }),
            (err) => {
                assert.strictEqual(err.code, 'ACTION_REJECTED');
                assert.strictEqual(err.details.reason, 'invalid: mine');
                return true;
            });
    });

    it('WebSocket path: a neighbouring NEW_ACTION event is ignored', async function () {
        const listeners = {};
        const ws = {
            isConnected: () => true,
            on:  (evt, fn) => { (listeners[evt] = listeners[evt] || []).push(fn); },
            off: (evt, fn) => { listeners[evt] = (listeners[evt] || []).filter(f => f !== fn); },
            emit:(evt, msg) => { (listeners[evt] || []).slice().forEach(fn => fn(msg)); },
        };
        const sdk = { ws, _requireExplorer: () => ({ getTransaction: async () => null }) };
        const waiter = new ActionWaiter(sdk);
        const p = waiter.waitForTxid(TXID, { timeout: 1200, pollInterval: 50, actionIndex: N });
        // Pre-fix this event settled the wait as 'valid', masking whatever the
        // target action turned out to be.
        ws.emit('NEW_ACTION', { data: { tx_hash: TXID, action_index: N_1, status: 'valid' } });
        await assert.rejects(() => p, (err) => err.code === 'CONFIRMATION_TIMEOUT');
    });

    it('WebSocket path: the target NEW_ACTION event still settles the wait', async function () {
        const listeners = {};
        const ws = {
            isConnected: () => true,
            on:  (evt, fn) => { (listeners[evt] = listeners[evt] || []).push(fn); },
            off: (evt, fn) => { listeners[evt] = (listeners[evt] || []).filter(f => f !== fn); },
            emit:(evt, msg) => { (listeners[evt] || []).slice().forEach(fn => fn(msg)); },
        };
        const sdk = { ws, _requireExplorer: () => ({ getTransaction: async () => null }) };
        const waiter = new ActionWaiter(sdk);
        const p = waiter.waitForTxid(TXID, { timeout: 2000, pollInterval: 50, actionIndex: N });
        ws.emit('NEW_ACTION', { data: { tx_hash: TXID, action_index: N, status: 'valid' } });
        const result = await p;
        assert.strictEqual(result.action_index, N);
        assert.strictEqual(result.statusSource, 'indexer');
    });
});
