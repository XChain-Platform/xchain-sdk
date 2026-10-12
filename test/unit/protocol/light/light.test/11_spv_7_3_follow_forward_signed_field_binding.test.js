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
 * SPV §7.3 rotation following only trusts what a quorum signed.
 *
 *   - A served checkpoint accepted through followForward must equal the attested
 *     range step on every signed field, so no explorer-forged field comes back
 *     from verifyBalance / verifyAction as verified.
 *   - followForward refuses a step below the checkpoint-commitment flag day,
 *     whose roots are outside the signed bytes and so cannot carry trust forward.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const M      = require('../../../../../src/merkle.js');
const light  = require('../../../../../src/protocol/light_client.js');
const checkpoint = require('../../../../../src/checkpoint.js');

const CHAIN = 'BTC', NET = 'regtest', COIN = 'RBTC', TICK = 'XCHAIN', CAP = 'oracle_publish';
const ADDR_A = '1AddrAaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const EMPTY0_HEX = M.toHex(M.EMPTY[0]);
const EMPTY_ROOT = M.toHex(M.EMPTY[M.SMT_DEPTH]);

// Minimal persistent SMT, as in the §7.3 rotation suite, to materialize a proof's node store.
function buildStore(leaves) {
    const nodes = new Map();
    function descend(rootHex, keyBuf) {
        const siblings = new Array(M.SMT_DEPTH);
        let cur = rootHex, empty = false;
        for (let d = 0; d < M.SMT_DEPTH; d++) {
            const sibEmpty = M.toHex(M.EMPTY[M.SMT_DEPTH - 1 - d]);
            if (empty) { siblings[d] = sibEmpty; continue; }
            const row = nodes.get(cur) || null;
            if (!row) { empty = true; siblings[d] = sibEmpty; continue; }
            const bit = M.bitAt(keyBuf, d);
            siblings[d] = (bit === 0) ? row.right_hash : row.left_hash;
            cur         = (bit === 0) ? row.left_hash  : row.right_hash;
        }
        return siblings;
    }
    function update(rootHex, keyBuf, leafHex) {
        const siblings = descend(rootHex, keyBuf);
        let cur = (leafHex == null) ? EMPTY0_HEX : leafHex;
        for (let d = M.SMT_DEPTH - 1; d >= 0; d--) {
            const bit = M.bitAt(keyBuf, d), sib = siblings[d];
            const parent = M.toHex(M.nodeHash(bit === 0 ? cur : sib, bit === 0 ? sib : cur));
            if (parent !== M.toHex(M.EMPTY[M.SMT_DEPTH - d])) nodes.set(parent, { left_hash: bit === 0 ? cur : sib, right_hash: bit === 0 ? sib : cur });
            cur = parent;
        }
        return cur;
    }
    let root = EMPTY_ROOT;
    for (const [keyHex, leafHex] of leaves) root = update(root, M.toBuf(keyHex), leafHex);
    return { root, descend };
}
function buildBalanceProof(address, tick, amountStr, height) {
    const keyBuf = M.balanceKey(CHAIN, NET, address, tick);
    const leaf = M.toHex(M.amountLeaf(amountStr));
    const store = buildStore([[M.toHex(keyBuf), leaf]]);
    const roots = { balances_root: store.root, stakes_root: EMPTY_ROOT };
    const stateRoot = M.toHex(M.stateRoot(roots));
    const sub = M.stateRootProof(roots, 'balances_root');
    const proof = { chain: CHAIN, network: NET, height, address, tick, amount: M.canonicalAmount(amountStr),
        smt_proof: { key: M.toHex(keyBuf), leaf_value: leaf, compressed: M.compressSmtProof(store.descend(store.root, keyBuf)) },
        sub_root_path: { index: sub.index, siblings: sub.siblings },
        balances_root: store.root, stakes_root: EMPTY_ROOT, state_root: stateRoot, state_root_version: 1 };
    return { proof, stateRoot };
}
function buildActionProof(height) {
    const rows = { block_index: 200,
        ledger: { credits: [{ action_index: 10, address: ADDR_A, tick: TICK, amount: '5' }], debits: [], escrows: [] },
        actions: [{ action_index: 10, tx_index: 100, action: 'ISSUE' }, { action_index: 11, tx_index: null, action: 'ORDER_MATCH' }],
        contracts: { contracts: [], state: [], executions: [], emissions: [], deposits: [], withdrawals: [] } };
    const leaves = M.blockMerkleLeaves(rows);
    const row = rows.actions[1];
    const mp = M.fixedMerkleProof(leaves, 2);                    // one ledger leaf, then the second action
    const proof = { chain: CHAIN, network: NET, height, action_index: row.action_index, tx_index: row.tx_index,
        action: row.action, leaf: M.toHex(M.actionsLeaf(row)),
        merkle_proof: { index: mp.index, siblings: mp.siblings },
        block_merkle_root: M.toHex(M.blockMerkleRoot(leaves)), block_merkle_version: 1 };
    return { proof, blockMerkleRoot: proof.block_merkle_root };
}
function rsigner() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const spki = publicKey.export({ format: 'der', type: 'spki' });
    return { privateKey, pubkey: spki.subarray(spki.length - 32).toString('hex') };
}
function signCp(cp, signers) {
    const canonical = checkpoint.canonicalCheckpoint(cp);
    cp.validator_signatures = signers.map((s) => ({ pubkey: s.pubkey,
        sig: crypto.sign(null, Buffer.from(canonical, 'utf8'), s.privateKey).toString('hex') }));
    return cp;
}
function buildStakesProof(members, total, height) {
    const entries = members.map((m) => [M.toHex(M.stakeKey(m.pubkey, CAP)), M.toHex(M.stakeMemberLeaf(m.source, m.weight))]);
    const tKey = M.stakeKey(M.STAKE_TOTAL_PUBKEY, CAP);
    entries.push([M.toHex(tKey), M.toHex(M.stakeTotalLeaf(total))]);
    const store = buildStore(entries);
    const roots = { balances_root: EMPTY_ROOT, stakes_root: store.root };
    const memberProof = (m) => {
        const keyBuf = M.stakeKey(m.pubkey, CAP);
        return { pubkey: m.pubkey, source: m.source, weight: m.weight,
            smt_proof: { key: M.toHex(keyBuf), leaf_value: M.toHex(M.stakeMemberLeaf(m.source, m.weight)),
                         compressed: M.compressSmtProof(store.descend(store.root, keyBuf)) } };
    };
    const proof = { chain: CHAIN, network: NET, height, stakes_root: store.root, balances_root: EMPTY_ROOT,
        sub_root_path: M.stateRootProof(roots, 'stakes_root'), state_root: M.toHex(M.stateRoot(roots)), state_root_version: 1,
        capabilities: { [CAP]: { total, validators: members.map(memberProof),
            total_proof: { key: M.toHex(tKey), leaf_value: M.toHex(M.stakeTotalLeaf(total)),
                           compressed: M.compressSmtProof(store.descend(store.root, tKey)) } } } };
    return { proof, stateRoot: proof.state_root };
}
function spyFetch(map) {
    const urls = [];
    const f = async (url) => {
        urls.push(url);
        for (const [needle, body] of map) if (url.includes(needle)) return { ok: true, status: 200, json: async () => body };
        return { ok: false, status: 404, json: async () => ({}) };
    };
    f.saw = (needle) => urls.some((u) => u.includes(needle));
    return f;
}
function cpAt(o) {
    return { chain: CHAIN, network: o.network || NET, block_index: o.block_index, block_hash: 'c0'.repeat(32),
        ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
        checkpoint_seq: o.checkpoint_seq == null ? 1 : o.checkpoint_seq, snapshot_block: o.snapshot_block,
        state_root: o.state_root, state_root_version: 1, block_merkle_root: o.block_merkle_root || 'bb'.repeat(32),
        block_merkle_version: 1, validator_signatures: [] };
}
const FORGED = { block_hash: 'f0'.repeat(32), ledger_hash: 'f1'.repeat(32), actions_hash: 'f2'.repeat(32),
    contract_hash: 'f3'.repeat(32), checkpoint_seq: 99,
    fold_archive: { match_batch_seq: 1, match_count: 1, batch_crc32: '00000000', total_chunks: 1 } };

describe('SPV §7.3: a rotation-followed checkpoint must match the attested step on every signed field', function () {
    beforeEach(function () { light.clearValidatorSetCache(); });

    for (const field of Object.keys(FORGED)) {
        it('verifyBalance refuses a served checkpoint whose ' + field + ' differs from the attested step', async function () {
            const launch = rsigner(), s1 = rsigner();
            const vs = buildStakesProof([{ pubkey: s1.pubkey, source: 'R1', weight: '100' }], '100', 110);
            const cp0 = cpAt({ block_index: 100, snapshot_block: 100, checkpoint_seq: 0, state_root: vs.stateRoot, block_merkle_root: 'aa'.repeat(32) });
            const bal = buildBalanceProof(ADDR_A, TICK, '42', 110);
            const cp1 = signCp(cpAt({ block_index: 110, snapshot_block: 110, state_root: bal.stateRoot }), [s1]);
            const served = Object.assign({}, cp1, { [field]: FORGED[field] });
            const f = spyFetch([['/api/proof/balance/', { proof: bal.proof, checkpoint: served }],
                ['/api/checkpoints/range', { checkpoints: [cp1] }], ['/api/proof/validator-set', { proof: vs.proof }]]);
            const r = await light.verifyBalance({ explorerUrl: 'https://x', coin: COIN, address: ADDR_A, tick: TICK, atHeight: 110,
                pinnedResolver: () => ({ checkpoint: cp0, validators: [{ pubkey: launch.pubkey, source: launch.pubkey, weight: '100' }] }), fetchImpl: f });
            assert.strictEqual(r.verified, false, 'a forged ' + field + ' must not come back verified');
            assert.strictEqual(r.reason, 'CHECKPOINT_QUORUM_FAILED');
            assert.strictEqual(f.saw('/verify'), false);
        });
    }

    it('verifyAction refuses a served checkpoint whose block_hash differs from the attested step', async function () {
        const launch = rsigner(), s1 = rsigner();
        const vs = buildStakesProof([{ pubkey: s1.pubkey, source: 'R1', weight: '100' }], '100', 210);
        const cp0 = cpAt({ block_index: 100, snapshot_block: 100, checkpoint_seq: 0, state_root: vs.stateRoot, block_merkle_root: 'aa'.repeat(32) });
        const act = buildActionProof(210);
        const cp1 = signCp(cpAt({ block_index: 210, snapshot_block: 210, state_root: 'cc'.repeat(32), block_merkle_root: act.blockMerkleRoot }), [s1]);
        const f = spyFetch([['/api/proof/action/', { proof: act.proof, checkpoint: Object.assign({}, cp1, { block_hash: FORGED.block_hash }) }],
            ['/api/checkpoints/range', { checkpoints: [cp1] }], ['/api/proof/validator-set', { proof: vs.proof }]]);
        const r = await light.verifyAction({ explorerUrl: 'https://x', coin: COIN, actionIndex: 11,
            pinnedResolver: () => ({ checkpoint: cp0, validators: [{ pubkey: launch.pubkey, source: launch.pubkey, weight: '100' }] }), fetchImpl: f });
        assert.strictEqual(r.verified, false);
        assert.strictEqual(r.reason, 'CHECKPOINT_QUORUM_FAILED');
    });
});

describe('SPV §7.3: followForward never adopts a step whose roots are unsigned', function () {
    beforeEach(function () { light.clearValidatorSetCache(); });

    it('followForward stops at a genuinely signed step below the commitment flag day (ROOTS_NOT_SIGNED)', async function () {
        const s1 = rsigner();
        const vs = buildStakesProof([{ pubkey: s1.pubkey, source: 'R1', weight: '100' }], '100', 900005);
        const cp0 = cpAt({ network: 'mainnet', block_index: 900000, snapshot_block: 900000, checkpoint_seq: 0, state_root: vs.stateRoot });
        const step = signCp(cpAt({ network: 'mainnet', block_index: 900010, snapshot_block: 900005, state_root: 'dd'.repeat(32) }), [s1]);
        assert.strictEqual(checkpoint.commitmentActive(step), false, 'fixture must sit below the flag day');
        const f = spyFetch([['/api/checkpoints/range', { checkpoints: [step] }], ['/api/proof/validator-set', { proof: vs.proof }]]);
        const r = await light.followForward({ explorerUrl: 'https://x', btcCoin: COIN, trustedCheckpoint: cp0, toHeight: 900010, fetchImpl: f });
        assert.strictEqual(r.reason, 'ROOTS_NOT_SIGNED@900010');
        assert.strictEqual(r.adopted.length, 0);
        assert.strictEqual(r.trusted.block_index, 900000, 'the trust root must not move onto an unsigned root');
        assert.strictEqual(f.saw('/api/proof/validator-set'), false);
    });
});
