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


function makeSigner() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const spki = publicKey.export({ format: 'der', type: 'spki' });
    return { privateKey, pubkeyHex: spki.subarray(spki.length - 32).toString('hex') };
}
function signCanonical(privateKey, canonical) {
    return crypto.sign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('hex');
}
// A quorum-signed checkpoint at `blockIndex`, plus the set that signed it.
function makeSignedCheckpoint(stateRoot, blockIndex) {
    const signer = makeSigner();
    const cp = {
        chain: CHAIN, network: NET, block_index: blockIndex, block_hash: 'c0'.repeat(32),
        ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
        checkpoint_seq: 0, snapshot_block: blockIndex,
        state_root: stateRoot, state_root_version: 1,
        block_merkle_root: 'e5'.repeat(32), block_merkle_version: 1,
        validator_signatures: []
    };
    const canonical = checkpoint.canonicalCheckpoint(cp);
    cp.validator_signatures = [{ pubkey: signer.pubkeyHex, sig: signCanonical(signer.privateKey, canonical) }];
    const validators = [{ pubkey: signer.pubkeyHex, source: signer.pubkeyHex, weight: '100' }];
    return { cp, validators };
}

// Two addresses proven against ONE shared balances tree, so both proofs bind
// to the same state_root and checkpoint height: the shape the cache exists for
// (a wallet verifying several addresses at the one checkpoint the poll saw).
function buildTwoAddressProofs(height) {
    const keyA = M.balanceKey(CHAIN, NET, ADDR_A, TICK);
    const keyZ = M.balanceKey(CHAIN, NET, ADDR_Z, TICK);
    const leafA = M.toHex(M.amountLeaf('42'));
    const leafZ = M.toHex(M.amountLeaf('7'));
    const store = buildStore([[M.toHex(keyA), leafA], [M.toHex(keyZ), leafZ]]);
    const balancesRoot = store.root, stakesRoot = EMPTY_ROOT;
    const stateRoot = M.toHex(M.stateRoot({ balances_root: balancesRoot, stakes_root: stakesRoot }));
    const sub = M.stateRootProof({ balances_root: balancesRoot, stakes_root: stakesRoot }, 'balances_root');
    function proofFor(addr, keyBuf, leaf, amt) {
        return { chain: CHAIN, network: NET, height, address: addr, tick: TICK,
            amount: M.canonicalAmount(amt),
            smt_proof: { key: M.toHex(keyBuf), leaf_value: leaf,
                         compressed: M.compressSmtProof(store.descend(balancesRoot, keyBuf)) },
            sub_root_path: { index: sub.index, siblings: sub.siblings },
            balances_root: balancesRoot, stakes_root: stakesRoot,
            state_root: stateRoot, state_root_version: 1 };
    }
    return { stateRoot, proofA: proofFor(ADDR_A, keyA, leafA, '42'), proofZ: proofFor(ADDR_Z, keyZ, leafZ, '7') };
}

// Routes a proof read by address (both addresses share `cp`) and counts every
// /api/checkpoint/.../verify call; `verifyOk: false` answers /verify with a
// transport failure so the "rejection is not cached" case can be driven.
function makeFetch({ proofA, proofZ, cp, validators, verifyOk, verifyCalls }) {
    return async (url) => {
        if (url.includes('/api/proof/balance/')) {
            if (url.includes(encodeURIComponent(ADDR_A))) return { ok: true, status: 200, json: async () => ({ proof: proofA, checkpoint: cp }) };
            if (url.includes(encodeURIComponent(ADDR_Z))) return { ok: true, status: 200, json: async () => ({ proof: proofZ, checkpoint: cp }) };
            return { ok: false, status: 404, json: async () => ({}) };
        }
        if (url.includes('/api/checkpoint/')) {
            verifyCalls.push(url);
            if (verifyOk === false) return { ok: false, status: 503, json: async () => ({}) };
            return { ok: true, status: 200, json: async () => ({ validators }) };
        }
        return { ok: false, status: 404, json: async () => ({}) };
    };
}

describe('SPV Phase 4: light.js validator-set cache (convenience /verify tier)', function () {

    beforeEach(function () {
        light.clearValidatorSetCache();
    });

    it('two proofs at ONE checkpoint height fetch the explorer /verify set once', async function () {
        const { stateRoot, proofA, proofZ } = buildTwoAddressProofs(100);
        const { cp, validators } = makeSignedCheckpoint(stateRoot, 100);
        const verifyCalls = [];
        const fetchImpl = makeFetch({ proofA, proofZ, cp, validators, verifyCalls });
        const rA = await light.verifyBalance({ explorerUrl: 'https://x', coin: COIN, address: ADDR_A, tick: TICK, atHeight: 100, fetchImpl });
        const rZ = await light.verifyBalance({ explorerUrl: 'https://x', coin: COIN, address: ADDR_Z, tick: TICK, atHeight: 100, fetchImpl });
        assert.strictEqual(rA.verified, true, rA.reason);
        assert.strictEqual(rZ.verified, true, rZ.reason);
        assert.strictEqual(verifyCalls.length, 1, 'the second proof at the same height must reuse the cached set');
    });

    it('concurrent proofs at ONE height share the SAME in-flight /verify read', async function () {
        // The wallet fans proof jobs through a pool of 6, so two proofs at one
        // height can be in flight together, not just sequential.
        const { stateRoot, proofA, proofZ } = buildTwoAddressProofs(100);
        const { cp, validators } = makeSignedCheckpoint(stateRoot, 100);
        const verifyCalls = [];
        const fetchImpl = makeFetch({ proofA, proofZ, cp, validators, verifyCalls });
        const [rA, rZ] = await Promise.all([
            light.verifyBalance({ explorerUrl: 'https://x', coin: COIN, address: ADDR_A, tick: TICK, atHeight: 100, fetchImpl }),
            light.verifyBalance({ explorerUrl: 'https://x', coin: COIN, address: ADDR_Z, tick: TICK, atHeight: 100, fetchImpl })
        ]);
        assert.strictEqual(rA.verified, true, rA.reason);
        assert.strictEqual(rZ.verified, true, rZ.reason);
        assert.strictEqual(verifyCalls.length, 1, 'only one /verify read should go out for two concurrent callers at one key');
    });

    it('a DIFFERENT checkpoint height fetches /verify again', async function () {
        const h100 = buildTwoAddressProofs(100);
        const s100 = makeSignedCheckpoint(h100.stateRoot, 100);
        const h200 = buildTwoAddressProofs(200);
        const s200 = makeSignedCheckpoint(h200.stateRoot, 200);
        const verifyCalls = [];
        const fetch100 = makeFetch({ proofA: h100.proofA, proofZ: h100.proofA, cp: s100.cp, validators: s100.validators, verifyCalls });
        const fetch200 = makeFetch({ proofA: h200.proofA, proofZ: h200.proofA, cp: s200.cp, validators: s200.validators, verifyCalls });
        const r100 = await light.verifyBalance({ explorerUrl: 'https://x', coin: COIN, address: ADDR_A, tick: TICK, atHeight: 100, fetchImpl: fetch100 });
        const r200 = await light.verifyBalance({ explorerUrl: 'https://x', coin: COIN, address: ADDR_A, tick: TICK, atHeight: 200, fetchImpl: fetch200 });
        assert.strictEqual(r100.verified, true, r100.reason);
        assert.strictEqual(r200.verified, true, r200.reason);
        assert.strictEqual(verifyCalls.length, 2, 'a different checkpoint height is a different cache key');
    });
});

describe('SPV Phase 4: light.js validator-set cache (convenience /verify tier)', function () {

    beforeEach(function () {
        light.clearValidatorSetCache();
    });

    it('clearValidatorSetCache() forces the same height to fetch /verify again', async function () {
        const { stateRoot, proofA, proofZ } = buildTwoAddressProofs(100);
        const { cp, validators } = makeSignedCheckpoint(stateRoot, 100);
        const verifyCalls = [];
        const fetchImpl = makeFetch({ proofA, proofZ, cp, validators, verifyCalls });
        const r1 = await light.verifyBalance({ explorerUrl: 'https://x', coin: COIN, address: ADDR_A, tick: TICK, atHeight: 100, fetchImpl });
        assert.strictEqual(r1.verified, true, r1.reason);
        light.clearValidatorSetCache();
        const r2 = await light.verifyBalance({ explorerUrl: 'https://x', coin: COIN, address: ADDR_A, tick: TICK, atHeight: 100, fetchImpl });
        assert.strictEqual(r2.verified, true, r2.reason);
        assert.strictEqual(verifyCalls.length, 2, 'clearing the cache must not leave a stale entry for this height');
    });

    it('a rejected /verify fetch is NOT cached: the next call fetches again', async function () {
        const { stateRoot, proofA } = buildTwoAddressProofs(100);
        const { cp, validators } = makeSignedCheckpoint(stateRoot, 100);
        const verifyCalls = [];
        const failing = makeFetch({ proofA, proofZ: proofA, cp, validators, verifyOk: false, verifyCalls });
        await assert.rejects(() => light.verifyBalance({ explorerUrl: 'https://x', coin: COIN, address: ADDR_A, tick: TICK, atHeight: 100, fetchImpl: failing }));
        assert.strictEqual(verifyCalls.length, 1);
        const working = makeFetch({ proofA, proofZ: proofA, cp, validators, verifyCalls });
        const r = await light.verifyBalance({ explorerUrl: 'https://x', coin: COIN, address: ADDR_A, tick: TICK, atHeight: 100, fetchImpl: working });
        assert.strictEqual(r.verified, true, r.reason);
        assert.strictEqual(verifyCalls.length, 2, 'a transport blip on /verify must not be pinned as a permanent failure');
    });
});
