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


const pinned = require('../../../src/protocol/pinned_checkpoints.js');

function makeSigner() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const spki = publicKey.export({ format: 'der', type: 'spki' });
    return { privateKey, pubkeyHex: spki.subarray(spki.length - 32).toString('hex') };
}
function sign(privateKey, canonical) {
    return crypto.sign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('hex');
}
// A signed checkpoint at the balance-proof height (100) for `signer`, with the
// given committed state_root, plus the qualifying validator set entry.
function signedBalanceCp(stateRoot, signer) {
    const cp = { chain: CHAIN, network: NET, block_index: 100, block_hash: 'c0'.repeat(32),
        ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
        checkpoint_seq: 0, snapshot_block: 100, state_root: stateRoot, state_root_version: 1,
        block_merkle_root: 'e5'.repeat(32), block_merkle_version: 1, validator_signatures: [] };
    cp.validator_signatures = [{ pubkey: signer.pubkeyHex, sig: sign(signer.privateKey, checkpoint.canonicalCheckpoint(cp)) }];
    return cp;
}
function validatorOf(signer) {
    return [{ pubkey: signer.pubkeyHex, source: signer.pubkeyHex, weight: '100' }];
}
// Records every URL it is asked for, so a test can assert the /verify endpoint
// (the explorer-trusted validator-set source) was or was not consulted.
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

describe('SPV D4: pinned launch trust root', function () {

    beforeEach(function () {
        light.clearValidatorSetCache();
    });

    it('the shipped registry is INERT: every real coin pins null (convenience path stands)', function () {
        for (const coin of ['BTC', 'TBTC', 'RBTC', 'LTC', 'TLTC', 'RLTC', 'DOGE', 'TDOGE', 'RDOGE']) {
            assert.strictEqual(pinned.getPinnedCheckpoint(coin), null, coin);
            assert.strictEqual(pinned.getPinnedValidators(coin), null, coin);
        }
        assert.strictEqual(pinned.getPinnedCheckpoint(null), null);
    });

    // A consumer holding only an SDK INSTANCE (the reference wallet holds `sdk`,
    // never the module namespace) must be able to ask which trust tier a verify
    // call will take, off the same object it calls verify on. Re-exported rather
    // than copied, so there is one registry and no second copy to drift.
    it('sdk.light re-exports the registry accessors, and they ARE the registry', function () {
        assert.strictEqual(light.getPinnedCheckpoint, pinned.getPinnedCheckpoint);
        assert.strictEqual(light.getPinnedValidators, pinned.getPinnedValidators);
        assert.strictEqual(light.getPinnedCheckpoint('BTC'), null);
    });

    it('verifyBalance uses the PINNED set and never fetches the explorer /verify endpoint', async function () {
        const { proof, stateRoot } = buildBalanceProof(ADDR_A, TICK, '42');
        const s = makeSigner();
        const cp = signedBalanceCp(stateRoot, s);
        const f = spyFetch([['/api/proof/balance/', { proof, checkpoint: cp }]]);   // NOTE: no /verify mapping
        const r = await light.verifyBalance({ explorerUrl: 'https://x', coin: COIN, address: ADDR_A,
            tick: TICK, atHeight: 100, pinnedResolver: () => ({ validators: validatorOf(s) }), fetchImpl: f });
        assert.strictEqual(r.verified, true, r.reason);
        assert.strictEqual(r.amount, M.canonicalAmount('42'));
        assert.strictEqual(f.saw('/verify'), false, 'must not consult the explorer validator-set endpoint when pinned');
        assert.strictEqual(f.saw('/api/proof/balance/'), true);
    });

    it('with NO pinned entry, verifyBalance falls back to the explorer /verify set (convenience path)', async function () {
        const { proof, stateRoot } = buildBalanceProof(ADDR_A, TICK, '42');
        const s = makeSigner();
        const cp = signedBalanceCp(stateRoot, s);
        const f = spyFetch([['/api/proof/balance/', { proof, checkpoint: cp }], ['/verify', { validators: validatorOf(s) }]]);
        const r = await light.verifyBalance({ explorerUrl: 'https://x', coin: COIN, address: ADDR_A,
            tick: TICK, atHeight: 100, pinnedResolver: () => null, fetchImpl: f });
        assert.strictEqual(r.verified, true, r.reason);
        assert.strictEqual(f.saw('/verify'), true, 'must consult the explorer set when nothing is pinned');
    });
});

describe('SPV D4: pinned launch trust root', function () {

    beforeEach(function () {
        light.clearValidatorSetCache();
    });

    it('a checkpoint NOT signed by the pinned set fails quorum (no silent fallback to the explorer)', async function () {
        const { proof, stateRoot } = buildBalanceProof(ADDR_A, TICK, '42');
        const pinnedSigner = makeSigner(), rogue = makeSigner();
        const cp = signedBalanceCp(stateRoot, rogue);                 // signed by a non-pinned key
        const f = spyFetch([['/api/proof/balance/', { proof, checkpoint: cp }], ['/verify', { validators: validatorOf(rogue) }]]);
        const r = await light.verifyBalance({ explorerUrl: 'https://x', coin: COIN, address: ADDR_A,
            tick: TICK, atHeight: 100, pinnedResolver: () => ({ validators: validatorOf(pinnedSigner) }), fetchImpl: f });
        assert.strictEqual(r.verified, false);
        assert.strictEqual(r.reason, 'CHECKPOINT_QUORUM_FAILED');
        assert.strictEqual(f.saw('/verify'), false, 'pinned set is authoritative; it must not fall back to the explorer set');
    });

    it('verifyAction also uses the pinned set and skips /verify', async function () {
        const { proof, blockMerkleRoot } = buildActionProof();        // height 200, action_index 11
        const s = makeSigner();
        const cp = { chain: CHAIN, network: NET, block_index: 200, block_hash: 'c0'.repeat(32),
            ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
            checkpoint_seq: 0, snapshot_block: 200, state_root: 'd4'.repeat(32), state_root_version: 1,
            block_merkle_root: blockMerkleRoot, block_merkle_version: 1, validator_signatures: [] };
        cp.validator_signatures = [{ pubkey: s.pubkeyHex, sig: sign(s.privateKey, checkpoint.canonicalCheckpoint(cp)) }];
        const f = spyFetch([['/api/proof/action/', { proof, checkpoint: cp }]]);
        const r = await light.verifyAction({ explorerUrl: 'https://x', coin: COIN, actionIndex: 11,
            pinnedResolver: () => ({ validators: validatorOf(s) }), fetchImpl: f });
        assert.strictEqual(r.verified, true, r.reason);
        assert.strictEqual(f.saw('/verify'), false);
    });
});
