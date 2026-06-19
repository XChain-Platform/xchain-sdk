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
const M      = require('../../src/merkle.js');
const light  = require('../../src/light.js');
const checkpoint = require('../../src/checkpoint.js');

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
function buildBalanceProof(address, tick, amountStr) {
    const keyBuf = M.balanceKey(CHAIN, NET, address, tick);
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
        state_root: stateRoot, state_root_version: 1
    };
    return { proof, stateRoot };
}

// A §5 action inclusion proof + the committed block_merkle_root.
function buildActionProof() {
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
        chain: CHAIN, network: NET, height: 200, action_index: row.action_index,
        tx_index: row.tx_index, action: row.action,
        leaf: M.toHex(M.actionsLeaf({ action_index: row.action_index, tx_index: row.tx_index, action: row.action })),
        merkle_proof: { index: mp.index, siblings: mp.siblings },
        block_merkle_root: blockMerkleRoot, block_merkle_version: 1
    };
    return { proof, blockMerkleRoot };
}

describe('SPV Phase 4: sdk.light pure verifiers', function () {

    it('verifyBalanceProof ACCEPTS a valid membership proof, returning the bound amount', function () {
        const { proof, stateRoot } = buildBalanceProof(ADDR_A, TICK, '5');
        const r = light.verifyBalanceProof(proof, stateRoot, CHAIN, NET);
        assert.strictEqual(r.verified, true, r.reason);
        assert.strictEqual(r.amount, M.canonicalAmount('5'));
    });

    it('verifyBalanceProof ACCEPTS a non-inclusion proof for a zero balance', function () {
        const { proof, stateRoot } = buildBalanceProof(ADDR_Z, TICK, '0');
        const r = light.verifyBalanceProof(proof, stateRoot, CHAIN, NET);
        assert.strictEqual(r.verified, true, r.reason);
        assert.strictEqual(r.amount, M.canonicalAmount('0'));
    });

    it('verifyBalanceProof REJECTS a server lying about the amount', function () {
        const { proof, stateRoot } = buildBalanceProof(ADDR_A, TICK, '5');
        proof.amount = '999';                                   // leaf still commits 5
        const r = light.verifyBalanceProof(proof, stateRoot, CHAIN, NET);
        assert.strictEqual(r.verified, false);
        assert.strictEqual(r.reason, 'LEAF_AMOUNT_MISMATCH');
    });

    it('verifyBalanceProof REJECTS a proof whose key does not match the requested address', function () {
        const { proof, stateRoot } = buildBalanceProof(ADDR_A, TICK, '5');
        assert.strictEqual(light.verifyBalanceProof(proof, stateRoot, CHAIN, NET).verified, true);  // sanity
        proof.address = ADDR_Z;                                 // smt_proof.key no longer matches
        assert.strictEqual(light.verifyBalanceProof(proof, stateRoot, CHAIN, NET).reason, 'KEY_MISMATCH');
    });

    it('verifyBalanceProof REJECTS when bound to the WRONG state_root', function () {
        const { proof } = buildBalanceProof(ADDR_A, TICK, '5');
        const r = light.verifyBalanceProof(proof, 'ff'.repeat(32), CHAIN, NET);
        assert.strictEqual(r.verified, false);
        assert.strictEqual(r.reason, 'SUBROOT_BIND_INVALID');
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
});

describe('SPV Phase 4: sdk.light.verifyBalance end-to-end (signed checkpoint, mocked fetch)', function () {

    // A real Ed25519 signer for the federation quorum.
    function makeSigner() {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
        const spki = publicKey.export({ format: 'der', type: 'spki' });
        const pubkeyHex = spki.subarray(spki.length - 32).toString('hex');   // raw 32-byte key
        return { privateKey, pubkeyHex };
    }
    function signCanonical(privateKey, canonical) {
        return crypto.sign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('hex');
    }

    function makeSignedCheckpoint(stateRoot) {
        const signer = makeSigner();
        const cp = {
            chain: CHAIN, network: NET, block_index: 100, block_hash: 'c0'.repeat(32),
            ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
            checkpoint_seq: 0, snapshot_block: 100,
            state_root: stateRoot, state_root_version: 1,
            block_merkle_root: 'e5'.repeat(32), block_merkle_version: 1,
            validator_signatures: []
        };
        const canonical = checkpoint.canonicalCheckpoint(cp);
        cp.validator_signatures = [{ pubkey: signer.pubkeyHex, sig: signCanonical(signer.privateKey, canonical) }];
        const validators = [{ pubkey: signer.pubkeyHex, source: signer.pubkeyHex, weight: '100' }];
        return { cp, validators };
    }

    function mockFetch(map) {
        return async (url) => {
            for (const [needle, body] of map) if (url.includes(needle))
                return { ok: true, status: 200, json: async () => body };
            return { ok: false, status: 404, json: async () => ({}) };
        };
    }

    it('verifies a real balance against a quorum-signed checkpoint (supplied validators)', async function () {
        const { proof, stateRoot } = buildBalanceProof(ADDR_A, TICK, '42');
        const { cp, validators } = makeSignedCheckpoint(stateRoot);
        const fetchImpl = mockFetch([['/api/proof/balance/', { proof, checkpoint: cp }]]);
        const r = await light.verifyBalance({ explorerUrl: 'https://x', coin: COIN, address: ADDR_A,
            tick: TICK, atHeight: 100, validators, fetchImpl });
        assert.strictEqual(r.verified, true, r.reason);
        assert.strictEqual(r.amount, M.canonicalAmount('42'));
        assert.strictEqual(r.height, 100);
        assert.strictEqual(r.weighted, true);
    });

    it('returns CHECKPOINT_QUORUM_FAILED when the signature does not meet quorum', async function () {
        const { proof, stateRoot } = buildBalanceProof(ADDR_A, TICK, '42');
        const { cp } = makeSignedCheckpoint(stateRoot);
        cp.validator_signatures = [{ pubkey: 'aa'.repeat(32), sig: 'bb'.repeat(64) }];   // bogus
        const validators = [{ pubkey: 'aa'.repeat(32), source: 'aa'.repeat(32), weight: '100' }];
        const fetchImpl = mockFetch([['/api/proof/balance/', { proof, checkpoint: cp }]]);
        const r = await light.verifyBalance({ explorerUrl: 'https://x', coin: COIN, address: ADDR_A,
            tick: TICK, atHeight: 100, validators, fetchImpl });
        assert.strictEqual(r.verified, false);
        assert.strictEqual(r.reason, 'CHECKPOINT_QUORUM_FAILED');
    });

    it('rejects a forged amount even when the checkpoint quorum is valid', async function () {
        const { proof, stateRoot } = buildBalanceProof(ADDR_A, TICK, '42');
        proof.amount = '1000000';                               // tamper post-signing
        const { cp, validators } = makeSignedCheckpoint(stateRoot);
        const fetchImpl = mockFetch([['/api/proof/balance/', { proof, checkpoint: cp }]]);
        const r = await light.verifyBalance({ explorerUrl: 'https://x', coin: COIN, address: ADDR_A,
            tick: TICK, atHeight: 100, validators, fetchImpl });
        assert.strictEqual(r.verified, false);
        assert.strictEqual(r.reason, 'LEAF_AMOUNT_MISMATCH');
    });
});
