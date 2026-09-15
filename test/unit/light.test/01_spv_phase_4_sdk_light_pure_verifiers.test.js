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
const M      = require('../../../src/merkle.js');
const light  = require('../../../src/protocol/light_client.js');
const checkpoint = require('../../../src/checkpoint.js');

// The AUTHORITATIVE ANCHOR wire vector lives in the docs repo (hub and indexer
// vendor byte-identical copies; the SDK reads the original rather than adding a
// fourth copy to keep in sync). Resolved exactly as the other cross-repo guards
// resolve their siblings, so a single-repo clone skips instead of failing, and
// XCHAIN_REQUIRE_SIBLINGS=1 turns that silence into a failure.
const SIBLING_ROOT = process.env.XCHAIN_SIBLING_ROOT || path.join(__dirname, '..', '..', '..', '..');
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

// verifyLockedBalanceProof (XCHAIN_ESC, SPV sub-tree protocol reference §3 Stage B)
// A locked proof is a balance proof in a second key domain of the SAME
// balances_root, so the builder just swaps the key derivation. The extra
// rule under test is LIVENESS: the SDK's own activation carrier decides
// whether the domain is committed at the proof's height, whatever the
// server said, because no proof can tell (an armed-but-idle domain and an
// inert one commit byte-identical roots).
const SUBACT = require('../../../src/state_subtree_activation.js');
const ESC_KEY = CHAIN + ':' + NET;
// BTC:regtest carries a REAL armed height, so "disarm" must not DELETE the key:
// that silently wipes the fleet-armed set for every later test in the process, and
// it is the third place this trap has appeared across the two armings. Disarming
// instead pushes the threshold out of reach, which is inert at every height a test
// uses while leaving the key present, and the real value is put back afterwards.
const ESC_HAD   = Object.prototype.hasOwnProperty.call(SUBACT.ESCROW_LOCKED_LEAF_ACTIVATION, ESC_KEY);
const ESC_PRIOR = SUBACT.ESCROW_LOCKED_LEAF_ACTIVATION[ESC_KEY];
function armEsc() { SUBACT.ESCROW_LOCKED_LEAF_ACTIVATION[ESC_KEY] = 0; }
function disarmEsc() { SUBACT.ESCROW_LOCKED_LEAF_ACTIVATION[ESC_KEY] = Number.MAX_SAFE_INTEGER; }


function buildLockedProof(address, tick, amountStr) {
    const keyBuf = M.escrowKey(CHAIN, NET, address, tick);
    const present = amountStr !== '0';
    const leaf = present ? M.toHex(M.amountLeaf(amountStr)) : null;
    const store = buildStore(present ? [[M.toHex(keyBuf), leaf]] : []);
    const balancesRoot = store.root, stakesRoot = EMPTY_ROOT;
    const stateRoot = M.toHex(M.stateRoot({ balances_root: balancesRoot, stakes_root: stakesRoot }));
    const siblings = store.descend(balancesRoot, keyBuf);
    const sub = M.stateRootProof({ balances_root: balancesRoot, stakes_root: stakesRoot }, 'balances_root');
    const proof = {
        chain: CHAIN, network: NET, height: 100, address, tick,
        amount: M.canonicalAmount(amountStr),
        smt_proof: { key: M.toHex(keyBuf), leaf_value: leaf, compressed: M.compressSmtProof(siblings) },
        sub_root_path: { index: sub.index, siblings: sub.siblings },
        balances_root: balancesRoot, stakes_root: stakesRoot,
        state_root: stateRoot, state_root_version: 2
    };
    return { proof, stateRoot };
}

// Reading the arming gate off proof.height is unsafe: the explorer authors that
// field and nothing hashes it. With a MID-CHAIN arming height that lets a hostile
// or drifted server relabel a genuine pre-arming non-inclusion as "at an armed
// height" and get verified:true, amount:'0' out of a root that never covered ESC.
// buildLockedProof labels its proofs height 100, so arming at 150 puts the label
// above nothing and arming at 50 puts it above the threshold.
function armEscAt(h) { SUBACT.ESCROW_LOCKED_LEAF_ACTIVATION[ESC_KEY] = h; }

describe('SPV Phase 4: sdk.light pure verifiers', function () {

    beforeEach(function () {
        light.clearValidatorSetCache();
    });

    it('verifyLockedBalanceProof ACCEPTS a valid membership proof at an armed height', function () {
        armEsc();
        try {
            const { proof, stateRoot } = buildLockedProof(ADDR_A, TICK, '7');
            const r = light.verifyLockedBalanceProof(proof, stateRoot, CHAIN, NET);
            assert.strictEqual(r.verified, true, r.reason);
            assert.strictEqual(r.amount, M.canonicalAmount('7'));
        } finally { disarmEsc(); }
    });

    it('verifyLockedBalanceProof ACCEPTS zero-locked as non-inclusion at an armed height', function () {
        armEsc();
        try {
            const { proof, stateRoot } = buildLockedProof(ADDR_Z, TICK, '0');
            const r = light.verifyLockedBalanceProof(proof, stateRoot, CHAIN, NET);
            assert.strictEqual(r.verified, true, r.reason);
            assert.strictEqual(r.amount, M.canonicalAmount('0'));
        } finally { disarmEsc(); }
    });

    it('verifyLockedBalanceProof REFUSES below the armed height, whatever the server served', function () {
        // Map inert (the shipped default): a below-arming non-inclusion would
        // "verify" against a root that never covered the domain and mean nothing.
        const { proof, stateRoot } = buildLockedProof(ADDR_A, TICK, '7');
        const r = light.verifyLockedBalanceProof(proof, stateRoot, CHAIN, NET);
        assert.strictEqual(r.verified, false);
        assert.strictEqual(r.reason, 'ESCROW_LEAF_NOT_COMMITTED');
    });

    it('verifyLockedBalanceProof refuses a garbage height fail-closed (strict parse)', function () {
        armEsc();
        try {
            const { proof, stateRoot } = buildLockedProof(ADDR_A, TICK, '7');
            proof.height = '100abc';                    // coerces >= 0 under lax parsing
            const r = light.verifyLockedBalanceProof(proof, stateRoot, CHAIN, NET);
            assert.strictEqual(r.reason, 'ESCROW_LEAF_NOT_COMMITTED');
        } finally { disarmEsc(); }
    });
});

describe('SPV Phase 4: sdk.light pure verifiers', function () {

    beforeEach(function () {
        light.clearValidatorSetCache();
    });

    it('verifyLockedBalanceProof gates on the TRUSTED height, not the served label', function () {
        armEscAt(150);
        try {
            const { proof, stateRoot } = buildLockedProof(ADDR_A, TICK, '7');
            // Label and trusted height agree at 100, which is BELOW the armed 150.
            const r = light.verifyLockedBalanceProof(proof, stateRoot, CHAIN, NET, null, 100);
            assert.strictEqual(r.verified, false);
            assert.strictEqual(r.reason, 'ESCROW_LEAF_NOT_COMMITTED');
        } finally { disarmEsc(); }
    });

    it('verifyLockedBalanceProof accepts once the TRUSTED height is at the armed height', function () {
        armEscAt(50);
        try {
            const { proof, stateRoot } = buildLockedProof(ADDR_A, TICK, '7');
            const r = light.verifyLockedBalanceProof(proof, stateRoot, CHAIN, NET, null, 100);
            assert.strictEqual(r.verified, true, r.reason);
            assert.strictEqual(r.amount, M.canonicalAmount('7'));
        } finally { disarmEsc(); }
    });

    it('verifyLockedBalanceProof REJECTS a proof relabelled off the trusted height', function () {
        armEscAt(50);
        try {
            const { proof, stateRoot } = buildLockedProof(ADDR_A, TICK, '7');
            proof.height = 99999;                    // server says "fresh", caller trusts 100
            const r = light.verifyLockedBalanceProof(proof, stateRoot, CHAIN, NET, null, 100);
            assert.strictEqual(r.verified, false);
            assert.strictEqual(r.reason, 'PROOF_HEIGHT_MISMATCH');
        } finally { disarmEsc(); }
    });

    // The old signature has no trusted height to gate on, so it gates at 0: the
    // strictest reading, verifying only where the leaf is armed from genesis. Before
    // this, the same call VERIFIED because the label (100) cleared the armed 50.
    it('verifyLockedBalanceProof with no trusted height refuses a mid-chain arming', function () {
        armEscAt(50);
        try {
            const { proof, stateRoot } = buildLockedProof(ADDR_A, TICK, '7');
            const r = light.verifyLockedBalanceProof(proof, stateRoot, CHAIN, NET);
            assert.strictEqual(r.verified, false);
            assert.strictEqual(r.reason, 'ESCROW_LEAF_NOT_COMMITTED');
        } finally { disarmEsc(); }
    });
});

describe('SPV Phase 4: sdk.light pure verifiers', function () {

    beforeEach(function () {
        light.clearValidatorSetCache();
    });

    // The wrapper is the only in-SDK holder of a quorum-signed checkpoint, so it is
    // what supplies the trusted height. trustedCheckpoint keeps this off the quorum
    // machinery, which the verifyBalance suite already covers.
    it('verifyLockedBalance binds the served proof to the trusted checkpoint height', async function () {
        armEscAt(50);
        try {
            const { proof, stateRoot } = buildLockedProof(ADDR_A, TICK, '7');
            const cp = { block_index: 100, state_root: stateRoot, chain: CHAIN, network: NET };
            const serve = (p) => async () => ({ ok: true, status: 200, json: async () => ({ proof: p }) });

            const ok = await light.verifyLockedBalance({ explorerUrl: 'https://x', coin: COIN,
                address: ADDR_A, tick: TICK, trustedCheckpoint: cp, fetchImpl: serve(proof) });
            assert.strictEqual(ok.verified, true, ok.reason);
            assert.strictEqual(ok.amount, M.canonicalAmount('7'));
            assert.strictEqual(ok.height, 100);

            const relabelled = Object.assign({}, proof, { height: 99999 });
            const bad = await light.verifyLockedBalance({ explorerUrl: 'https://x', coin: COIN,
                address: ADDR_A, tick: TICK, trustedCheckpoint: cp, fetchImpl: serve(relabelled) });
            assert.strictEqual(bad.verified, false);
            assert.strictEqual(bad.reason, 'PROOF_HEIGHT_MISMATCH');
        } finally { disarmEsc(); }
    });

    it('verifyLockedBalance returns the server refusal instead of throwing', async function () {
        const fetchImpl = async () => ({ ok: true, status: 200,
            json: async () => ({ error: 'ESCROW_LEAF_NOT_COMMITTED' }) });
        const r = await light.verifyLockedBalance({ explorerUrl: 'https://x', coin: COIN,
            address: ADDR_A, tick: TICK, fetchImpl });
        assert.strictEqual(r.verified, false);
        assert.strictEqual(r.reason, 'ESCROW_LEAF_NOT_COMMITTED');
    });

    it('verifyLockedBalanceProof REJECTS a spendable-domain proof (KEY_MISMATCH both ways)', function () {
        armEsc();
        try {
            const spend  = buildBalanceProof(ADDR_A, TICK, '5');
            const locked = buildLockedProof(ADDR_A, TICK, '7');
            assert.strictEqual(light.verifyLockedBalanceProof(spend.proof, spend.stateRoot, CHAIN, NET).reason, 'KEY_MISMATCH');
            assert.strictEqual(light.verifyBalanceProof(locked.proof, locked.stateRoot, CHAIN, NET).reason, 'KEY_MISMATCH');
        } finally { disarmEsc(); }
    });
});

describe('SPV Phase 4: sdk.light pure verifiers', function () {

    beforeEach(function () {
        light.clearValidatorSetCache();
    });

    it('verifyLockedBalanceProof REJECTS a server lying about the locked amount', function () {
        armEsc();
        try {
            const { proof, stateRoot } = buildLockedProof(ADDR_A, TICK, '7');
            proof.amount = '1';                          // leaf still commits 7
            const r = light.verifyLockedBalanceProof(proof, stateRoot, CHAIN, NET);
            assert.strictEqual(r.reason, 'LEAF_AMOUNT_MISMATCH');
        } finally { disarmEsc(); }
    });

    it('verifyActionProof ACCEPTS a valid action inclusion proof (tx_index NULL)', function () {
        const { proof, blockMerkleRoot } = buildActionProof();
        const r = light.verifyActionProof(proof, blockMerkleRoot);
        assert.strictEqual(r.verified, true, r.reason);
    });

    it('verifyActionProof REJECTS a tampered action string', function () {
        const { proof, blockMerkleRoot } = buildActionProof();
        proof.action = 'SEND';                                  // leaf no longer matches the bytes
        const r = light.verifyActionProof(proof, blockMerkleRoot);
        assert.strictEqual(r.verified, false);
        assert.strictEqual(r.reason, 'LEAF_MISMATCH');
    });

    it('verifyActionProof REJECTS a valid leaf bound to the WRONG block_merkle_root', function () {
        const { proof } = buildActionProof();
        const r = light.verifyActionProof(proof, 'ab'.repeat(32));
        assert.strictEqual(r.verified, false);
        assert.strictEqual(r.reason, 'MERKLE_PROOF_INVALID');
    });
    after(function(){
        if(ESC_HAD) SUBACT.ESCROW_LOCKED_LEAF_ACTIVATION[ESC_KEY] = ESC_PRIOR;
        else delete SUBACT.ESCROW_LOCKED_LEAF_ACTIVATION[ESC_KEY];
    });
});
