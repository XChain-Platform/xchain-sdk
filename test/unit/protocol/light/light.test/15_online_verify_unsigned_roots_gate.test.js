/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * The online verifiers read a Merkle root off a served checkpoint only when a
 * validator signature covers it. Below the checkpoint-commitment flag day the roots
 * sit outside the signed bytes, so a genuinely signed rootless checkpoint stays
 * quorum-valid whatever roots the explorer attaches; verifyBalance, verifyLockedBalance
 * and verifyAction must refuse it (ROOTS_NOT_SIGNED) instead of verifying against it.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const M      = require('../../../../../src/merkle.js');
const light  = require('../../../../../src/protocol/light_client.js');
const checkpoint = require('../../../../../src/checkpoint.js');

const CHAIN = 'BTC', COIN = 'RBTC', TICK = 'XCHAIN';
const ADDR_A = '1AddrAaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const EMPTY0_HEX = M.toHex(M.EMPTY[0]);
const EMPTY_ROOT = M.toHex(M.EMPTY[M.SMT_DEPTH]);

// One-leaf sparse tree: the node store a proof descends.
function buildStore(keyHex, leafHex) {
    const nodes = new Map();
    const keyBuf = M.toBuf(keyHex);
    let cur = leafHex;
    const siblings = new Array(M.SMT_DEPTH);
    for (let d = M.SMT_DEPTH - 1; d >= 0; d--) {
        const bit = M.bitAt(keyBuf, d), sib = M.toHex(M.EMPTY[M.SMT_DEPTH - 1 - d]);
        siblings[d] = sib;
        const parent = M.toHex(M.nodeHash(bit === 0 ? cur : sib, bit === 0 ? sib : cur));
        nodes.set(parent, { left_hash: bit === 0 ? cur : sib, right_hash: bit === 0 ? sib : cur });
        cur = parent;
    }
    return { root: cur, siblings };
}
function balanceProof(network, height) {
    const keyHex = M.toHex(M.balanceKey(CHAIN, network, ADDR_A, TICK));
    const leaf = M.toHex(M.amountLeaf('42'));
    const store = buildStore(keyHex, leaf);
    const roots = { balances_root: store.root, stakes_root: EMPTY_ROOT };
    const sub = M.stateRootProof(roots, 'balances_root');
    const proof = { chain: CHAIN, network, height, address: ADDR_A, tick: TICK, amount: M.canonicalAmount('42'),
        smt_proof: { key: keyHex, leaf_value: leaf, compressed: M.compressSmtProof(store.siblings) },
        sub_root_path: { index: sub.index, siblings: sub.siblings },
        balances_root: store.root, stakes_root: EMPTY_ROOT, state_root: M.toHex(M.stateRoot(roots)), state_root_version: 1 };
    return { proof, stateRoot: proof.state_root };
}
function actionProof(network, height) {
    const rows = { block_index: height,
        ledger: { credits: [{ action_index: 10, address: ADDR_A, tick: TICK, amount: '5' }], debits: [], escrows: [] },
        actions: [{ action_index: 10, tx_index: 100, action: 'ISSUE' }, { action_index: 11, tx_index: null, action: 'ORDER_MATCH' }],
        contracts: { contracts: [], state: [], executions: [], emissions: [], deposits: [], withdrawals: [] } };
    const leaves = M.blockMerkleLeaves(rows);
    const row = rows.actions[1];
    const mp = M.fixedMerkleProof(leaves, 2);
    const proof = { chain: CHAIN, network, height, action_index: row.action_index, tx_index: row.tx_index,
        action: row.action, leaf: M.toHex(M.actionsLeaf(row)),
        merkle_proof: { index: mp.index, siblings: mp.siblings },
        block_merkle_root: M.toHex(M.blockMerkleRoot(leaves)), block_merkle_version: 1 };
    return { proof, blockMerkleRoot: proof.block_merkle_root };
}
function signer() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const spki = publicKey.export({ format: 'der', type: 'spki' });
    return { privateKey, pubkey: spki.subarray(spki.length - 32).toString('hex') };
}
function signedCp(s, o) {
    const cp = { chain: CHAIN, network: o.network, block_index: o.block_index, block_hash: 'c0'.repeat(32),
        ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
        checkpoint_seq: 1, snapshot_block: o.snapshot_block, state_root: o.state_root, state_root_version: 1,
        block_merkle_root: o.block_merkle_root, block_merkle_version: 1 };
    cp.validator_signatures = [{ pubkey: s.pubkey,
        sig: crypto.sign(null, Buffer.from(checkpoint.canonicalCheckpoint(cp), 'utf8'), s.privateKey).toString('hex') }];
    return cp;
}
function fetchOf(needle, body) {
    return async (url) => url.includes(needle)
        ? { ok: true, status: 200, json: async () => body }
        : { ok: false, status: 404, json: async () => ({}) };
}

// mainnet sits below its commitment flag day at this snapshot; regtest is active from 0.
const BELOW = { network: 'mainnet', block_index: 900010, snapshot_block: 900005 };
const ACTIVE = { network: 'regtest', block_index: 110, snapshot_block: 106 };
const coinFor = (fixture) => fixture.network === 'mainnet' ? 'BTC' : COIN;

describe('online verifiers refuse the roots of a checkpoint below the commitment flag day', function () {
    const s = signer();
    const validators = [{ pubkey: s.pubkey, source: s.pubkey, weight: '100' }];

    it('fixtures sit on the intended sides of the flag day', function () {
        assert.strictEqual(checkpoint.commitmentActive(BELOW), false);
        assert.strictEqual(checkpoint.commitmentActive(ACTIVE), true);
    });

    it('verifyBalance returns ROOTS_NOT_SIGNED for a signed rootless checkpoint carrying explorer-chosen roots', async function () {
        const bal = balanceProof(BELOW.network, BELOW.block_index);
        const cp = signedCp(s, Object.assign({ state_root: bal.stateRoot, block_merkle_root: 'bb'.repeat(32) }, BELOW));
        const r = await light.verifyBalance({ explorerUrl: '', coin: coinFor(BELOW), address: ADDR_A, tick: TICK,
            validators, fetchImpl: fetchOf('/api/proof/balance/', { proof: bal.proof, checkpoint: cp }) });
        assert.strictEqual(r.reason, 'ROOTS_NOT_SIGNED');
        assert.strictEqual(r.verified, false);
        assert.strictEqual(r.amount, null);
    });

    it('verifyBalance still verifies the same proof once the checkpoint is above the flag day', async function () {
        const bal = balanceProof(ACTIVE.network, ACTIVE.block_index);
        const cp = signedCp(s, Object.assign({ state_root: bal.stateRoot, block_merkle_root: 'bb'.repeat(32) }, ACTIVE));
        const r = await light.verifyBalance({ explorerUrl: '', coin: coinFor(ACTIVE), address: ADDR_A, tick: TICK,
            validators, fetchImpl: fetchOf('/api/proof/balance/', { proof: bal.proof, checkpoint: cp }) });
        assert.strictEqual(r.verified, true, r.reason);
        assert.strictEqual(r.amount, M.canonicalAmount('42'));
    });

    it('verifyAction returns ROOTS_NOT_SIGNED for a signed rootless checkpoint carrying an explorer-chosen block root', async function () {
        const act = actionProof(BELOW.network, BELOW.block_index);
        const cp = signedCp(s, Object.assign({ state_root: 'dd'.repeat(32), block_merkle_root: act.blockMerkleRoot }, BELOW));
        const r = await light.verifyAction({ explorerUrl: '', coin: coinFor(BELOW), actionIndex: 11,
            validators, fetchImpl: fetchOf('/api/proof/action/', { proof: act.proof, checkpoint: cp }) });
        assert.strictEqual(r.reason, 'ROOTS_NOT_SIGNED');
        assert.strictEqual(r.verified, false);
    });

    it('verifyAction still verifies the same proof once the checkpoint is above the flag day', async function () {
        const act = actionProof(ACTIVE.network, ACTIVE.block_index);
        const cp = signedCp(s, Object.assign({ state_root: 'dd'.repeat(32), block_merkle_root: act.blockMerkleRoot }, ACTIVE));
        const r = await light.verifyAction({ explorerUrl: '', coin: coinFor(ACTIVE), actionIndex: 11,
            validators, fetchImpl: fetchOf('/api/proof/action/', { proof: act.proof, checkpoint: cp }) });
        assert.strictEqual(r.verified, true, r.reason);
    });

    it('verifyLockedBalance returns ROOTS_NOT_SIGNED below the flag day and not above it', async function () {
        const ask = async (at) => {
            const proof = { chain: CHAIN, network: at.network, height: at.block_index, address: ADDR_A, tick: TICK };
            const cp = signedCp(s, Object.assign({ state_root: 'ee'.repeat(32), block_merkle_root: 'bb'.repeat(32) }, at));
            return light.verifyLockedBalance({ explorerUrl: '', coin: coinFor(at), address: ADDR_A, tick: TICK,
                validators, fetchImpl: fetchOf('/api/proof/locked-balance/', { proof, checkpoint: cp }) });
        };
        const below = await ask(BELOW);
        assert.strictEqual(below.verified, false);
        assert.strictEqual(below.reason, 'ROOTS_NOT_SIGNED');
        const active = await ask(ACTIVE);
        assert.notStrictEqual(active.reason, 'ROOTS_NOT_SIGNED');
    });
});
