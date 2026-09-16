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
 * SPV light client (Phase 4) round-trip unit tests.
 *
 * Builds REAL balance + action proofs with the sdk merkle.js twin (the same
 * module the indexer commits with and the explorer serves with), then asserts:
 *   - the pure verifiers ACCEPT a valid proof (membership, non-inclusion, action),
 *   - they REJECT forged proofs (wrong amount, wrong key, swapped root, bad leaf),
 *   - the network verifyBalance path integrates quorum + binding end-to-end against
 *     a REAL Ed25519-signed checkpoint, with a mocked fetch (no server).
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const M      = require('../../../../src/merkle.js');
const light  = require('../../../../src/protocol/light_client.js');
const checkpoint = require('../../../../src/checkpoint.js');

// The AUTHORITATIVE ANCHOR wire vector lives in the docs repo (hub and indexer
// vendor byte-identical copies; the SDK reads the original rather than adding a
// fourth copy to keep in sync). Resolved exactly as the other cross-repo guards
// resolve their siblings, so a single-repo clone skips instead of failing, and
// XCHAIN_REQUIRE_SIBLINGS=1 turns that silence into a failure.
const SIBLING_ROOT = process.env.XCHAIN_SIBLING_ROOT || path.join(__dirname, '../..', '..', '..', '..');
const DOCS_DIR     = process.env.XCHAIN_DOCS_DIR || process.env.XCHAIN_DOCUMENTATION_DIR
                     || path.join(SIBLING_ROOT, 'xchain-documentation');
const VECTOR_FILE  = path.join(DOCS_DIR, 'protocol', 'test-vectors', 'anchor_canonical.json');

function missingSibling(what) {
    if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
        throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but ' + what + ' was not found');
    return null;
}

const CHAIN = 'BTC', NET = 'regtest', COIN = 'RBTC', TICK = 'XCHAIN';
const ADDR_A = '1AddrAaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ADDR_Z = '1AddrZzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';
const EMPTY0_HEX = M.toHex(M.EMPTY[0]);
const EMPTY_ROOT = M.toHex(M.EMPTY[M.SMT_DEPTH]);

// Minimal persistent SMT (mirrors proofServer.test buildStore) to materialize the
// node store a proof descends.
function buildStore(leaves) {
    const nodes = new Map();
    const get = (h) => nodes.get(h) || null;
    function descend(rootHex, keyBuf) {
        const siblings = new Array(M.SMT_DEPTH);
        let cur = rootHex, empty = false;
        for (let d = 0; d < M.SMT_DEPTH; d++) {
            const sibEmpty = M.toHex(M.EMPTY[M.SMT_DEPTH - 1 - d]);
            if (empty) { siblings[d] = sibEmpty; continue; }
            const row = get(cur);
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
            const left  = (bit === 0) ? cur : sib;
            const right = (bit === 0) ? sib : cur;
            const parent = M.toHex(M.nodeHash(left, right));
            if (parent !== M.toHex(M.EMPTY[M.SMT_DEPTH - d])) nodes.set(parent, { left_hash: left, right_hash: right });
            cur = parent;
        }
        return cur;
    }
    let root = EMPTY_ROOT;
    for (const [keyHex, leafHex] of leaves) root = update(root, M.toBuf(keyHex), leafHex);
    return { root, nodes, descend };
}

// A §4.4 BalanceProof + the committed state_root, exactly as the explorer serves.
// `height` defaults to 100 and must equal the block_index of whatever checkpoint the
// proof is served with: proofServer emits `height: Number(cp.block_index)` for the SAME
// cp it returns, and the verifier enforces that binding.
function buildBalanceProof(address, tick, amountStr, height) {
    const keyBuf = M.balanceKey(CHAIN, NET, address, tick);
    const present = amountStr !== '0';
    const leaf = present ? M.toHex(M.amountLeaf(amountStr)) : null;
    const store = buildStore(present ? [[M.toHex(keyBuf), leaf]] : []);
    const balancesRoot = store.root, stakesRoot = EMPTY_ROOT;
    const stateRoot = M.toHex(M.stateRoot({ balances_root: balancesRoot, stakes_root: stakesRoot }));
    const siblings = store.descend(balancesRoot, keyBuf);
    const sub = M.stateRootProof({ balances_root: balancesRoot, stakes_root: stakesRoot }, 'balances_root');
    const proof = {
        chain: CHAIN, network: NET, height: (height == null ? 100 : height), address, tick,
        amount: M.canonicalAmount(amountStr),
        smt_proof: { key: M.toHex(keyBuf), leaf_value: leaf, compressed: M.compressSmtProof(siblings) },
        sub_root_path: { index: sub.index, siblings: sub.siblings },
        balances_root: balancesRoot, stakes_root: stakesRoot,
        state_root: stateRoot, state_root_version: 1
    };
    return { proof, stateRoot };
}
// A §5 action inclusion proof + the committed block_merkle_root. `height` defaults to
// 200 and, as with buildBalanceProof, must equal the served checkpoint's block_index.
function buildActionProof(height) {
    const rows = {
        block_index: 200,
        ledger: { credits: [{ action_index: 10, address: ADDR_A, tick: TICK, amount: '5' }],
                  debits: [], escrows: [] },
        actions: [{ action_index: 10, tx_index: 100, action: 'ISSUE' },
                  { action_index: 11, tx_index: null, action: 'ORDER_MATCH' }],
        contracts: { contracts: [], state: [], executions: [], emissions: [], deposits: [], withdrawals: [] }
    };
    const leaves = M.blockMerkleLeaves(rows);
    const blockMerkleRoot = M.toHex(M.blockMerkleRoot(leaves));
    const ledgerCount = 1;                       // one credit
    const pos = 1;                               // second action (tx_index NULL)
    const row = rows.actions[pos];
    const leafIndex = ledgerCount + pos;
    const mp = M.fixedMerkleProof(leaves, leafIndex);
    const proof = {
        chain: CHAIN, network: NET, height: (height == null ? 200 : height), action_index: row.action_index,
        tx_index: row.tx_index, action: row.action,
        leaf: M.toHex(M.actionsLeaf({ action_index: row.action_index, tx_index: row.tx_index, action: row.action })),
        merkle_proof: { index: mp.index, siblings: mp.siblings },
        block_merkle_root: blockMerkleRoot, block_merkle_version: 1
    };
    return { proof, blockMerkleRoot };
}


const CAP = 'oracle_publish';

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
// A /proof/validator-set response proving `members` (+ source-deduped total)
// against a real stakes tree, plus the committed state_root that tree rolls up
// to. `height` is the BTC snapshot height the proof answers for.
function buildStakesProof(members, total, height) {
    const entries = members.map((m) => [M.toHex(M.stakeKey(m.pubkey, CAP)), M.toHex(M.stakeMemberLeaf(m.source, m.weight))]);
    entries.push([M.toHex(M.stakeKey(M.STAKE_TOTAL_PUBKEY, CAP)), M.toHex(M.stakeTotalLeaf(total))]);
    const store = buildStore(entries);
    const stakesRoot = store.root, balancesRoot = EMPTY_ROOT;
    const stateRoot = M.toHex(M.stateRoot({ balances_root: balancesRoot, stakes_root: stakesRoot }));
    const memberProof = (m) => {
        const keyBuf = M.stakeKey(m.pubkey, CAP);
        return { pubkey: m.pubkey, source: m.source, weight: m.weight,
            smt_proof: { key: M.toHex(keyBuf), leaf_value: M.toHex(M.stakeMemberLeaf(m.source, m.weight)),
                         compressed: M.compressSmtProof(store.descend(stakesRoot, keyBuf)) } };
    };
    const tKey = M.stakeKey(M.STAKE_TOTAL_PUBKEY, CAP);
    const proof = {
        chain: CHAIN, network: NET, height, stakes_root: stakesRoot, balances_root: balancesRoot,
        sub_root_path: M.stateRootProof({ balances_root: balancesRoot, stakes_root: stakesRoot }, 'stakes_root'),
        state_root: stateRoot, state_root_version: 1,
        capabilities: { [CAP]: { total, validators: members.map(memberProof),
            total_proof: { key: M.toHex(tKey), leaf_value: M.toHex(M.stakeTotalLeaf(total)),
                           compressed: M.compressSmtProof(store.descend(stakesRoot, tKey)) } } }
    };
    return { proof, stateRoot, stakesRoot };
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
function pinnedCp(stateRoot) {
    return { chain: CHAIN, network: NET, block_index: 100, snapshot_block: 100, checkpoint_seq: 0,
        state_root: stateRoot, state_root_version: 1, block_merkle_root: 'aa'.repeat(32),
        block_merkle_version: 1, validator_signatures: [] };
}

describe('SPV §7.3: rotation-aware pinned path (followForward)', function () {

    beforeEach(function () {
        light.clearValidatorSetCache();
    });

    // ── the followForward primitive itself (no direct coverage until here)

    it('followForward adopts a rotated checkpoint proven against the trusted stakes_root', async function () {
        const s1 = rsigner();
        const vs = buildStakesProof([{ pubkey: s1.pubkey, source: 'R1', weight: '100' }], '100', 110);
        const cp0 = pinnedCp(vs.stateRoot);                       // commits the set that signs cp1
        const cp1 = signCp({ chain: CHAIN, network: NET, block_index: 110, snapshot_block: 110, checkpoint_seq: 1,
            state_root: 'dd'.repeat(32), state_root_version: 1, block_merkle_root: 'bb'.repeat(32),
            block_merkle_version: 1, validator_signatures: [] }, [s1]);
        const f = spyFetch([['/api/checkpoints/range', { checkpoints: [cp1] }], ['/api/proof/validator-set', { proof: vs.proof }]]);
        const r = await light.followForward({ explorerUrl: 'https://x', btcCoin: COIN, trustedCheckpoint: cp0, toHeight: 110, fetchImpl: f });
        assert.strictEqual(r.reason, null, r.reason);
        assert.strictEqual(r.adopted.length, 1);
        assert.strictEqual(r.trusted.block_index, 110);
    });

    it('followForward STOPS at a checkpoint the proven set does not sign (QUORUM_FAILED)', async function () {
        const s1 = rsigner(), rogue = rsigner();
        const vs = buildStakesProof([{ pubkey: s1.pubkey, source: 'R1', weight: '100' }], '100', 110);
        const cp0 = pinnedCp(vs.stateRoot);
        const cp1 = signCp({ chain: CHAIN, network: NET, block_index: 110, snapshot_block: 110, checkpoint_seq: 1,
            state_root: 'dd'.repeat(32), state_root_version: 1, block_merkle_root: 'bb'.repeat(32),
            block_merkle_version: 1, validator_signatures: [] }, [rogue]);   // signed by a key NOT in the proven set
        const f = spyFetch([['/api/checkpoints/range', { checkpoints: [cp1] }], ['/api/proof/validator-set', { proof: vs.proof }]]);
        const r = await light.followForward({ explorerUrl: 'https://x', btcCoin: COIN, trustedCheckpoint: cp0, toHeight: 110, fetchImpl: f });
        assert.strictEqual(r.adopted.length, 0);
        assert.ok(r.reason && r.reason.startsWith('QUORUM_FAILED@'), r.reason);
        assert.strictEqual(r.trusted.block_index, 100);           // trust root unchanged
    });

    it('followForward STOPS when the validator-set proof does not bind to the trusted root', async function () {
        const s1 = rsigner();
        const vs = buildStakesProof([{ pubkey: s1.pubkey, source: 'R1', weight: '100' }], '100', 110);
        const cp0 = pinnedCp('ff'.repeat(32));                     // trusted root the VS proof can't bind into
        const cp1 = signCp({ chain: CHAIN, network: NET, block_index: 110, snapshot_block: 110, checkpoint_seq: 1,
            state_root: 'dd'.repeat(32), state_root_version: 1, block_merkle_root: 'bb'.repeat(32),
            block_merkle_version: 1, validator_signatures: [] }, [s1]);
        const f = spyFetch([['/api/checkpoints/range', { checkpoints: [cp1] }], ['/api/proof/validator-set', { proof: vs.proof }]]);
        const r = await light.followForward({ explorerUrl: 'https://x', btcCoin: COIN, trustedCheckpoint: cp0, toHeight: 110, fetchImpl: f });
        assert.strictEqual(r.adopted.length, 0);
        assert.ok(r.reason && r.reason.startsWith('VALIDATOR_SET_UNVERIFIED@'), r.reason);
    });
});

describe('SPV §7.3: rotation-aware pinned path (followForward)', function () {

    beforeEach(function () {
        light.clearValidatorSetCache();
    });

    // ── verifyBalance / verifyAction roll the pinned root forward over rotation ──

    it('verifyBalance follows the pinned root forward to a rotated checkpoint and verifies (no /verify)', async function () {
        const launch = rsigner(), s1 = rsigner();               // launch set rotated OUT; s1 signs in its place
        const vs = buildStakesProof([{ pubkey: s1.pubkey, source: 'R1', weight: '100' }], '100', 110);
        const cp0 = pinnedCp(vs.stateRoot);
        const bal = buildBalanceProof(ADDR_A, TICK, '42', 110);  // served at cp1's height
        const cp1 = signCp({ chain: CHAIN, network: NET, block_index: 110, snapshot_block: 110, checkpoint_seq: 1,
            state_root: bal.stateRoot, state_root_version: 1, block_merkle_root: 'bb'.repeat(32),
            block_merkle_version: 1, validator_signatures: [] }, [s1]);
        const f = spyFetch([
            ['/api/proof/balance/', { proof: bal.proof, checkpoint: cp1 }],
            ['/api/checkpoints/range', { checkpoints: [cp1] }],
            ['/api/proof/validator-set', { proof: vs.proof }],
            ['/verify', { validators: [{ pubkey: s1.pubkey, source: s1.pubkey, weight: '100' }] }]   // must NOT be used
        ]);
        const r = await light.verifyBalance({ explorerUrl: 'https://x', coin: COIN, address: ADDR_A, tick: TICK, atHeight: 110,
            pinnedResolver: () => ({ checkpoint: cp0, validators: [{ pubkey: launch.pubkey, source: launch.pubkey, weight: '100' }] }), fetchImpl: f });
        assert.strictEqual(r.verified, true, r.reason);
        assert.strictEqual(r.amount, M.canonicalAmount('42'));
        assert.strictEqual(f.saw('/api/proof/validator-set'), true, 'must prove the rotated set against the stakes_root');
        assert.strictEqual(f.saw('/verify'), false, 'rotation must not fall back to the explorer set');
    });

    it('verifyBalance rotation fails closed (CHECKPOINT_QUORUM_FAILED, no /verify) when the walk cannot reach the served checkpoint', async function () {
        const launch = rsigner(), s1 = rsigner();
        const vs = buildStakesProof([{ pubkey: s1.pubkey, source: 'R1', weight: '100' }], '100', 110);
        const cp0 = pinnedCp(vs.stateRoot);
        const bal = buildBalanceProof(ADDR_A, TICK, '42', 110);  // served at cp1's height
        const cp1 = signCp({ chain: CHAIN, network: NET, block_index: 110, snapshot_block: 110, checkpoint_seq: 1,
            state_root: bal.stateRoot, state_root_version: 1, block_merkle_root: 'bb'.repeat(32),
            block_merkle_version: 1, validator_signatures: [] }, [s1]);
        const f = spyFetch([
            ['/api/proof/balance/', { proof: bal.proof, checkpoint: cp1 }],
            ['/api/checkpoints/range', { checkpoints: [] }],      // range is empty -> cannot follow forward
            ['/verify', { validators: [{ pubkey: s1.pubkey, source: s1.pubkey, weight: '100' }] }]
        ]);
        const r = await light.verifyBalance({ explorerUrl: 'https://x', coin: COIN, address: ADDR_A, tick: TICK, atHeight: 110,
            pinnedResolver: () => ({ checkpoint: cp0, validators: [{ pubkey: launch.pubkey, source: launch.pubkey, weight: '100' }] }), fetchImpl: f });
        assert.strictEqual(r.verified, false);
        assert.strictEqual(r.reason, 'CHECKPOINT_QUORUM_FAILED');
        assert.strictEqual(f.saw('/verify'), false, 'a rotation that cannot be followed must not downgrade to the explorer set');
    });
});

describe('SPV §7.3: rotation-aware pinned path (followForward)', function () {

    beforeEach(function () {
        light.clearValidatorSetCache();
    });

    it('verifyAction also follows the pinned root forward across rotation', async function () {
        const launch = rsigner(), s1 = rsigner();
        const vs = buildStakesProof([{ pubkey: s1.pubkey, source: 'R1', weight: '100' }], '100', 210);
        const cp0 = pinnedCp(vs.stateRoot);
        const act = buildActionProof(210);                       // served at cp1's height, action_index 11
        const cp1 = signCp({ chain: CHAIN, network: NET, block_index: 210, snapshot_block: 210, checkpoint_seq: 1,
            state_root: 'cc'.repeat(32), state_root_version: 1, block_merkle_root: act.blockMerkleRoot,
            block_merkle_version: 1, validator_signatures: [] }, [s1]);
        const f = spyFetch([
            ['/api/proof/action/', { proof: act.proof, checkpoint: cp1 }],
            ['/api/checkpoints/range', { checkpoints: [cp1] }],
            ['/api/proof/validator-set', { proof: vs.proof }]
        ]);
        const r = await light.verifyAction({ explorerUrl: 'https://x', coin: COIN, actionIndex: 11,
            pinnedResolver: () => ({ checkpoint: cp0, validators: [{ pubkey: launch.pubkey, source: launch.pubkey, weight: '100' }] }), fetchImpl: f });
        assert.strictEqual(r.verified, true, r.reason);
        assert.strictEqual(f.saw('/verify'), false);
    });

    it('a pinned set that STILL signs a later checkpoint verifies directly, with no forward walk', async function () {
        const launch = rsigner();
        const bal = buildBalanceProof(ADDR_A, TICK, '7', 110);   // served at cp1's height
        const cp0 = pinnedCp('ab'.repeat(32));
        const cp1 = signCp({ chain: CHAIN, network: NET, block_index: 110, snapshot_block: 110, checkpoint_seq: 1,
            state_root: bal.stateRoot, state_root_version: 1, block_merkle_root: 'bb'.repeat(32),
            block_merkle_version: 1, validator_signatures: [] }, [launch]);
        const f = spyFetch([['/api/proof/balance/', { proof: bal.proof, checkpoint: cp1 }]]);  // no range / VS mappings
        const r = await light.verifyBalance({ explorerUrl: 'https://x', coin: COIN, address: ADDR_A, tick: TICK, atHeight: 110,
            pinnedResolver: () => ({ checkpoint: cp0, validators: [{ pubkey: launch.pubkey, source: launch.pubkey, weight: '100' }] }), fetchImpl: f });
        assert.strictEqual(r.verified, true, r.reason);
        assert.strictEqual(r.amount, M.canonicalAmount('7'));
        assert.strictEqual(f.saw('/api/checkpoints/range'), false, 'no rotation walk when the pinned set still signs');
        assert.strictEqual(f.saw('/api/proof/validator-set'), false);
    });
});
