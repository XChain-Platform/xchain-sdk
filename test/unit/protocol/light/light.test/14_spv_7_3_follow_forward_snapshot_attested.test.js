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
 ********************************************************************/

'use strict';

const assert = require('assert');
const M = require('../../../../../src/merkle.js');
const light = require('../../../../../src/protocol/light_client.js');

const CHAIN = 'BTC', NET = 'regtest', COIN = 'RBTC', CAP = 'oracle_publish';
const EMPTY0 = M.toHex(M.EMPTY[0]), EMPTY_ROOT = M.toHex(M.EMPTY[M.SMT_DEPTH]);

function buildStore(leaves){
    const nodes = new Map();
    function descend(root, key){
        const siblings = new Array(M.SMT_DEPTH);
        let current = root, empty = false;
        for(let depth = 0; depth < M.SMT_DEPTH; depth++){
            const emptySibling = M.toHex(M.EMPTY[M.SMT_DEPTH - 1 - depth]);
            const row = empty ? null : nodes.get(current);
            if(!row){ empty = true; siblings[depth] = emptySibling; continue; }
            const bit = M.bitAt(key, depth);
            siblings[depth] = bit === 0 ? row.right_hash : row.left_hash;
            current = bit === 0 ? row.left_hash : row.right_hash;
        }
        return siblings;
    }
    function update(root, key, leaf){
        const siblings = descend(root, key);
        let current = leaf == null ? EMPTY0 : leaf;
        for(let depth = M.SMT_DEPTH - 1; depth >= 0; depth--){
            const bit = M.bitAt(key, depth), sibling = siblings[depth];
            const left = bit === 0 ? current : sibling, right = bit === 0 ? sibling : current;
            const parent = M.toHex(M.nodeHash(left, right));
            if(parent !== M.toHex(M.EMPTY[M.SMT_DEPTH - depth]))
                nodes.set(parent, { left_hash: left, right_hash: right });
            current = parent;
        }
        return current;
    }
    let root = EMPTY_ROOT;
    for(const [key, leaf] of leaves) root = update(root, M.toBuf(key), leaf);
    return { root, descend };
}

function validatorSetProof(height){
    const pubkey = '11'.repeat(32), source = 'source-1', weight = '100';
    const memberKey = M.stakeKey(pubkey, CAP), totalKey = M.stakeKey(M.STAKE_TOTAL_PUBKEY, CAP);
    const memberLeaf = M.stakeMemberLeaf(source, weight), totalLeaf = M.stakeTotalLeaf(weight);
    const store = buildStore([[M.toHex(memberKey), M.toHex(memberLeaf)],
        [M.toHex(totalKey), M.toHex(totalLeaf)]]);
    const roots = { balances_root: EMPTY_ROOT, stakes_root: store.root };
    const proof = { chain: CHAIN, network: NET, height, stakes_root: store.root,
        balances_root: EMPTY_ROOT, sub_root_path: M.stateRootProof(roots, 'stakes_root'),
        state_root: M.toHex(M.stateRoot(roots)), state_root_version: 1,
        capabilities: { [CAP]: { total: weight, validators: [{ pubkey, source, weight,
            smt_proof: { key: M.toHex(memberKey), leaf_value: M.toHex(memberLeaf),
                compressed: M.compressSmtProof(store.descend(store.root, memberKey)) } }],
        total_proof: { key: M.toHex(totalKey), leaf_value: M.toHex(totalLeaf),
            compressed: M.compressSmtProof(store.descend(store.root, totalKey)) } } } };
    return proof;
}

function checkpointAt(blockIndex, snapshotBlock, stateRoot){
    return { chain: CHAIN, network: NET, block_index: blockIndex, snapshot_block: snapshotBlock,
        checkpoint_seq: blockIndex, state_root: stateRoot, state_root_version: 1,
        block_merkle_root: 'bb'.repeat(32), block_merkle_version: 1,
        validator_signatures: [] };
}

function spyFetch(step, proof){
    const urls = [];
    const fetch = async url => {
        urls.push(url);
        if(url.includes('/api/checkpoints/range'))
            return { ok: true, status: 200, json: async () => ({ checkpoints: [step] }) };
        if(url.includes('/api/proof/validator-set'))
            return { ok: true, status: 200, json: async () => ({ proof }) };
        return { ok: false, status: 404, json: async () => ({}) };
    };
    fetch.saw = needle => urls.some(url => url.includes(needle));
    return fetch;
}

describe('SPV §7.3: followForward binds signer sets to attested snapshot heights', function () {
    beforeEach(function () { light.clearValidatorSetCache(); });

    it('stops before fetching a signer set when the buried snapshot height is not trusted', async function () {
        const proof = validatorSetProof(100);
        const trusted = checkpointAt(100, 100, proof.state_root);
        const fetch = spyFetch(checkpointAt(110, 110, 'dd'.repeat(32)), proof);
        const result = await light.followForward({ explorerUrl: 'https://x', btcCoin: COIN,
            trustedCheckpoint: trusted, toHeight: 110, fetchImpl: fetch });
        assert.strictEqual(result.reason, 'SNAPSHOT_NOT_ATTESTED@110');
        assert.strictEqual(result.adopted.length, 0);
        assert.strictEqual(fetch.saw('/api/proof/validator-set'), false);
    });

    it('rejects a proof whose returned height differs from the buried snapshot height', async function () {
        const trustedProof = validatorSetProof(99);
        const trusted = checkpointAt(100, 100, trustedProof.state_root);
        const fetch = spyFetch(checkpointAt(110, 106, 'dd'.repeat(32)), trustedProof);
        const result = await light.followForward({ explorerUrl: 'https://x', btcCoin: COIN,
            trustedCheckpoint: trusted, toHeight: 110, fetchImpl: fetch });
        assert.strictEqual(result.reason, 'VALIDATOR_SET_HEIGHT_MISMATCH@110');
        assert.strictEqual(result.adopted.length, 0);
    });

    it('stops before fetching a signer set when snapshot_block is missing', async function () {
        const proof = validatorSetProof(100);
        const trusted = checkpointAt(100, 100, proof.state_root);
        const step = checkpointAt(110, undefined, 'dd'.repeat(32));
        const fetch = spyFetch(step, proof);
        const result = await light.followForward({ explorerUrl: 'https://x', btcCoin: COIN,
            trustedCheckpoint: trusted, toHeight: 110, fetchImpl: fetch });
        assert.strictEqual(result.reason, 'SNAPSHOT_NOT_ATTESTED@110');
        assert.strictEqual(fetch.saw('/api/proof/validator-set'), false);
    });

    it('accepts the explorer\'s decimal-string snapshot_block and proves the signer set at the buried height', async function () {
        const proof = validatorSetProof(100);
        const trusted = checkpointAt(100, 100, proof.state_root);
        const fetch = spyFetch(checkpointAt(110, '106', 'dd'.repeat(32)), proof);
        const result = await light.followForward({ explorerUrl: 'https://x', btcCoin: COIN,
            trustedCheckpoint: trusted, toHeight: 110, fetchImpl: fetch });
        assert.strictEqual(fetch.saw('/api/proof/validator-set?height=100'), true);
        assert.strictEqual(result.reason, 'QUORUM_FAILED@110');
    });

    it('refuses a snapshot_block string that is not a canonical decimal integer', async function () {
        const proof = validatorSetProof(100);
        const trusted = checkpointAt(100, 100, proof.state_root);
        const bad = ['', ' 106', '106 ', '0106', '+106', '-1', '1e2', '106.0', '0x6a', 'abc',
            '9007199254740993', 106.5, -1, NaN, null, {}];
        for(const value of bad){
            const fetch = spyFetch(checkpointAt(110, value, 'dd'.repeat(32)), proof);
            const result = await light.followForward({ explorerUrl: 'https://x', btcCoin: COIN,
                trustedCheckpoint: trusted, toHeight: 110, fetchImpl: fetch });
            assert.strictEqual(result.reason, 'SNAPSHOT_NOT_ATTESTED@110', String(value));
            assert.strictEqual(fetch.saw('/api/proof/validator-set'), false, String(value));
        }
    });
});
