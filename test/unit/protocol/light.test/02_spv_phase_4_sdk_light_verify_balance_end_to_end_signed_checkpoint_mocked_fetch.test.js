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

describe('SPV Phase 4: sdk.light.verifyBalance end-to-end (signed checkpoint, mocked fetch)', function () {

    beforeEach(function () {
        light.clearValidatorSetCache();
    });

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

    it('rejects a genuinely-committed proof for a DIFFERENT address than queried (query binding)', async function () {
        const ADDR_B = '1AddrBbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        // Server answers a query about ADDR_A with a valid, quorum-anchored proof for
        // ADDR_B's real balance. Everything about the proof verifies internally; only
        // the query binding catches the substitution.
        const { proof, stateRoot } = buildBalanceProof(ADDR_B, TICK, '999999');
        const { cp, validators } = makeSignedCheckpoint(stateRoot);
        const fetchImpl = mockFetch([['/api/proof/balance/', { proof, checkpoint: cp }]]);
        const r = await light.verifyBalance({ explorerUrl: 'https://x', coin: COIN, address: ADDR_A,
            tick: TICK, atHeight: 100, validators, fetchImpl });
        assert.strictEqual(r.verified, false);
        assert.strictEqual(r.reason, 'BALANCE_QUERY_MISMATCH');
    });
});

describe('SPV Phase 4: sdk.light.verifyBalance end-to-end (signed checkpoint, mocked fetch)', function () {

    beforeEach(function () {
        light.clearValidatorSetCache();
    });


    // The network path also wires the caller's identity through the verifier's own
    // `expected` binding, so a proof whose PROVEN KEY matches the request but whose
    // echoed address field does not (the field callers read) is refused inside the
    // verifier, not just by the expectedKey pre-check.
    it('rejects a proof whose echoed identity differs from the request even when the key matches', async function () {
        const ADDR_B = '1AddrBbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        const { proof, stateRoot } = buildBalanceProof(ADDR_A, TICK, '42');
        proof.address = ADDR_B;                 // key still proves ADDR_A, so the key pre-check passes
        const { cp, validators } = makeSignedCheckpoint(stateRoot);
        const fetchImpl = mockFetch([['/api/proof/balance/', { proof, checkpoint: cp }]]);
        const r = await light.verifyBalance({ explorerUrl: 'https://x', coin: COIN, address: ADDR_A,
            tick: TICK, atHeight: 100, validators, fetchImpl });
        assert.strictEqual(r.verified, false);
        assert.strictEqual(r.reason, 'REQUESTED_IDENTITY_MISMATCH');
    });

    it('rejects a genuinely-committed proof for a DIFFERENT tick than queried (query binding)', async function () {
        const { proof, stateRoot } = buildBalanceProof(ADDR_A, 'OTHERTOKEN', '999999');
        const { cp, validators } = makeSignedCheckpoint(stateRoot);
        const fetchImpl = mockFetch([['/api/proof/balance/', { proof, checkpoint: cp }]]);
        const r = await light.verifyBalance({ explorerUrl: 'https://x', coin: COIN, address: ADDR_A,
            tick: TICK, atHeight: 100, validators, fetchImpl });
        assert.strictEqual(r.verified, false);
        assert.strictEqual(r.reason, 'BALANCE_QUERY_MISMATCH');
    });

    // The response's `height` field is NOT hashed into the Merkle proof, so it is a free
    // label a drifted or hostile explorer can set at will. The binding
    // to cp.block_index was enforced only on the trustedCheckpoint branch, so a genuine
    // old proof relabelled with a fresh height verified with false age metadata.
    it('rejects a server-served proof whose height does not match the served checkpoint', async function () {
        const { proof, stateRoot } = buildBalanceProof(ADDR_A, TICK, '42');   // proof.height = 100
        const { cp, validators } = makeSignedCheckpoint(stateRoot);           // cp.block_index = 100
        proof.height = 999;                                                   // relabelled, proof itself untouched
        const fetchImpl = mockFetch([['/api/proof/balance/', { proof, checkpoint: cp }]]);
        const r = await light.verifyBalance({ explorerUrl: 'https://x', coin: COIN, address: ADDR_A,
            tick: TICK, atHeight: 100, validators, fetchImpl });
        assert.strictEqual(r.verified, false);
        assert.strictEqual(r.reason, 'PROOF_HEIGHT_MISMATCH');
        assert.strictEqual(r.height, 100, 'reported height comes from the signed checkpoint, not the label');
    });
});

describe('SPV Phase 4: sdk.light.verifyBalance end-to-end (signed checkpoint, mocked fetch)', function () {

    beforeEach(function () {
        light.clearValidatorSetCache();
    });


    // ?height=H means "the nearest checkpoint AT OR ABOVE H"; a checkpoint below H
    // answers a staler question than the caller asked.
    it('rejects a served checkpoint below the requested atHeight', async function () {
        const { proof, stateRoot } = buildBalanceProof(ADDR_A, TICK, '42');   // height 100
        const { cp, validators } = makeSignedCheckpoint(stateRoot);           // block_index 100
        const fetchImpl = mockFetch([['/api/proof/balance/', { proof, checkpoint: cp }]]);
        const r = await light.verifyBalance({ explorerUrl: 'https://x', coin: COIN, address: ADDR_A,
            tick: TICK, atHeight: 500, validators, fetchImpl });
        assert.strictEqual(r.verified, false);
        assert.strictEqual(r.reason, 'CHECKPOINT_BELOW_ATHEIGHT');
        assert.strictEqual(r.height, 100);
    });

    it('verifyAction rejects a server-served proof relabelled off its checkpoint height', async function () {
        const act = buildActionProof();                                       // height 200
        const signer = makeSigner();
        const cp = {
            chain: CHAIN, network: NET, block_index: 200, block_hash: 'c0'.repeat(32),
            ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
            checkpoint_seq: 0, snapshot_block: 200,
            state_root: 'd0'.repeat(32), state_root_version: 1,
            block_merkle_root: act.blockMerkleRoot, block_merkle_version: 1,
            validator_signatures: []
        };
        cp.validator_signatures = [{ pubkey: signer.pubkeyHex,
            sig: signCanonical(signer.privateKey, checkpoint.canonicalCheckpoint(cp)) }];
        const validators = [{ pubkey: signer.pubkeyHex, source: signer.pubkeyHex, weight: '100' }];
        const call = () => light.verifyAction({ explorerUrl: 'https://x', coin: COIN, actionIndex: 11,
            validators, fetchImpl: mockFetch([['/api/proof/action/', { proof: act.proof, checkpoint: cp }]]) });
        const ok = await call();
        assert.strictEqual(ok.verified, true, ok.reason);                      // control: binds when heights agree
        act.proof.height = 12345;                                              // relabel only, proof untouched
        const r = await call();
        assert.strictEqual(r.verified, false);
        assert.strictEqual(r.reason, 'PROOF_HEIGHT_MISMATCH');
        assert.strictEqual(r.height, 200);
    });
});
