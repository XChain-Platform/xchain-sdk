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
const SIBLING_ROOT = process.env.XCHAIN_SIBLING_ROOT || path.join(__dirname, '../..', '..', '..');
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
// cp it returns, and the verifier now enforces that binding.
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

// A Stage A contract-state proof + the committed state_root, mirroring the
// balance builder above but in the contract_state_root slot (index 4).
function buildContractStateProof(contractIndex, stateKey, valueStr) {
    const keyBuf = M.contractStateKey(CHAIN, NET, contractIndex, stateKey);
    const present = valueStr !== null;
    const leaf = present ? M.toHex(M.leafHash(valueStr)) : null;
    const store = buildStore(present ? [[M.toHex(keyBuf), leaf]] : []);
    const csRoot = store.root, balancesRoot = EMPTY_ROOT, stakesRoot = EMPTY_ROOT;
    const roots = { balances_root: balancesRoot, stakes_root: stakesRoot, contract_state_root: csRoot };
    const stateRoot = M.toHex(M.stateRoot(roots));
    const sub = M.stateRootProof(roots, 'contract_state_root');
    const proof = {
        chain: CHAIN, network: NET, height: 100,
        contract_index: contractIndex, state_key: stateKey,
        state_value: present ? valueStr : null,
        smt_proof: { key: M.toHex(keyBuf), leaf_value: leaf,
                     compressed: M.compressSmtProof(store.descend(csRoot, keyBuf)) },
        sub_root_path: { index: sub.index, siblings: sub.siblings },
        contract_state_root: csRoot, balances_root: balancesRoot, stakes_root: stakesRoot,
        state_root: stateRoot, state_root_version: 2
    };
    return { proof, stateRoot };
}
// The validator-set cache (light.js `_explorerValidators`) is keyed on
// (explorer, coin, checkpoint height), and several describe blocks below reuse
// 'https://x' / COIN / height 100. Clear it before every test so one test's
// cached /verify response can never answer another test's fetch assertion.

describe('SPV Phase 4: sdk.light pure verifiers', function () {

    beforeEach(function () {
        light.clearValidatorSetCache();
    });

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
});

describe('SPV Phase 4: sdk.light pure verifiers', function () {

    beforeEach(function () {
        light.clearValidatorSetCache();
    });

    // binding a proof to the REQUESTED identity, not just the echoed one
    // Every verifier re-derives its SMT key from fields carried IN the proof, so a
    // valid proof for a DIFFERENT question passes. The explorer's contract-state
    // double-decode made that happen for real (frontier, 2026-08-06): a
    // request for `a%41b` was answered, verifiably, for `aAb`.

    it('verifyBalanceProof ACCEPTS a proof that matches the requested identity', function () {
        const { proof, stateRoot } = buildBalanceProof(ADDR_A, TICK, '5');
        const r = light.verifyBalanceProof(proof, stateRoot, CHAIN, NET, { address: ADDR_A, tick: TICK });
        assert.strictEqual(r.verified, true, r.reason);
    });

    it('verifyBalanceProof REJECTS a wholly valid proof that answers a DIFFERENT address', function () {
        // The server proves ADDR_Z's balance while the client asked about ADDR_A.
        // Nothing in the proof is forged, which is precisely why the other checks pass.
        const { proof, stateRoot } = buildBalanceProof(ADDR_Z, TICK, '0');
        assert.strictEqual(light.verifyBalanceProof(proof, stateRoot, CHAIN, NET).verified, true,
            'unbound verification must still accept it: that is the gap');
        const r = light.verifyBalanceProof(proof, stateRoot, CHAIN, NET, { address: ADDR_A, tick: TICK });
        assert.strictEqual(r.verified, false);
        assert.strictEqual(r.reason, 'REQUESTED_IDENTITY_MISMATCH');
    });

    it('verifyContractStateProof REJECTS a valid proof for the key the double-decode would have produced', function () {
        // The exact production substitution: client asks `a%41b`, server answers `aAb`.
        const { proof, stateRoot } = buildContractStateProof(7, 'aAb', '"v"');
        assert.strictEqual(light.verifyContractStateProof(proof, stateRoot, CHAIN, NET).verified, true,
            'the substituted proof is internally valid, which is the whole problem');
        const bound = light.verifyContractStateProof(proof, stateRoot, CHAIN, NET,
                                                     { contract_index: 7, state_key: 'a%41b' });
        assert.strictEqual(bound.verified, false);
        assert.strictEqual(bound.reason, 'REQUESTED_IDENTITY_MISMATCH');
        //...and the honest answer still verifies against the same expectation.
        const honest = buildContractStateProof(7, 'a%41b', '"v"');
        assert.strictEqual(light.verifyContractStateProof(honest.proof, honest.stateRoot, CHAIN, NET,
                                                          { contract_index: 7, state_key: 'a%41b' }).verified, true);
    });
});

describe('SPV Phase 4: sdk.light pure verifiers', function () {

    beforeEach(function () {
        light.clearValidatorSetCache();
    });

    it('verifyContractStateProof REJECTS a proof for a different CONTRACT, and compares index as a string', function () {
        const { proof, stateRoot } = buildContractStateProof(8, 'owner', '"x"');
        assert.strictEqual(light.verifyContractStateProof(proof, stateRoot, CHAIN, NET,
                           { contract_index: 7 }).reason, 'REQUESTED_IDENTITY_MISMATCH');
        // A numeric index and its decimal spelling are the same request.
        assert.strictEqual(light.verifyContractStateProof(proof, stateRoot, CHAIN, NET,
                           { contract_index: '8' }).verified, true);
    });

    it('the identity binding is OPT-IN and ignores absent fields, so existing callers are unaffected', function () {
        const { proof, stateRoot } = buildBalanceProof(ADDR_A, TICK, '5');
        for (const expected of [undefined, null, {}, { address: undefined }, { tick: null }]) {
            assert.strictEqual(light.verifyBalanceProof(proof, stateRoot, CHAIN, NET, expected).verified, true,
                'expected=' + JSON.stringify(expected) + ' must not change the verdict');
        }
    });
});

describe('SPV Phase 4: sdk.light pure verifiers', function () {

    beforeEach(function () {
        light.clearValidatorSetCache();
    });

    it('verifyBalanceProof REJECTS when bound to the WRONG state_root', function () {
        const { proof } = buildBalanceProof(ADDR_A, TICK, '5');
        const r = light.verifyBalanceProof(proof, 'ff'.repeat(32), CHAIN, NET);
        assert.strictEqual(r.verified, false);
        assert.strictEqual(r.reason, 'SUBROOT_BIND_INVALID');
    });

    it('verifyBalanceProof REJECTS a forged false-zero bound to an EMPTY sub-tree slot (slot pinning)', function () {
        // ADDR_A genuinely holds 5 under the quorum-signed state_root.
        const keyBuf = M.balanceKey(CHAIN, NET, ADDR_A, TICK);
        const realStore = buildStore([[M.toHex(keyBuf), M.toHex(M.amountLeaf('5'))]]);
        const realBalancesRoot = realStore.root, stakesRoot = EMPTY_ROOT;
        const stateRoot = M.toHex(M.stateRoot({ balances_root: realBalancesRoot, stakes_root: stakesRoot }));

        // Forge: bind against the ownership_root slot (index 2), which is the
        // constant EMPTY_SMT_ROOT in state_root_version 1, and present a null
        // leaf + amount "0" for ADDR_A. The siblings for slot 2 are derivable
        // from the roots the server already serves.
        const emptyRootHex = M.toHex(M.EMPTY_SMT_ROOT);
        const emptyStore = buildStore([]);
        const forged = {
            chain: CHAIN, network: NET, height: 100, address: ADDR_A, tick: TICK,
            amount: M.canonicalAmount('0'),
            smt_proof: { key: M.toHex(keyBuf), leaf_value: null,
                compressed: M.compressSmtProof(emptyStore.descend(emptyStore.root, keyBuf)) },
            sub_root_path: M.stateRootProof({ balances_root: realBalancesRoot, stakes_root: stakesRoot }, 'ownership_root'),
            balances_root: emptyRootHex, stakes_root: stakesRoot,
            state_root: stateRoot, state_root_version: 1
        };
        // Sanity: the forged sub-path really targets slot 2 (the attack input).
        assert.strictEqual(forged.sub_root_path.index, M.STATE_SUBTREES.indexOf('ownership_root'));
        const r = light.verifyBalanceProof(forged, stateRoot, CHAIN, NET);
        assert.strictEqual(r.verified, false);
        assert.strictEqual(r.reason, 'SUBROOT_SLOT_MISMATCH');
    });
});
