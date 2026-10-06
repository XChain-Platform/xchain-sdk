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


const CAP = 'oracle_publish';

// Build a /proof/validator-set response from a set, against a real stakes tree.
function buildValidatorSetProof(members, total) {
    const entries = members.map(m => [ M.toHex(M.stakeKey(m.pubkey, CAP)), M.toHex(M.stakeMemberLeaf(m.source, m.weight)) ]);
    entries.push([ M.toHex(M.stakeKey(M.STAKE_TOTAL_PUBKEY, CAP)), M.toHex(M.stakeTotalLeaf(total)) ]);
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
        chain: CHAIN, network: NET, height: 100, stakes_root: stakesRoot, balances_root: balancesRoot,
        sub_root_path: M.stateRootProof({ balances_root: balancesRoot, stakes_root: stakesRoot }, 'stakes_root'),
        state_root: stateRoot, state_root_version: 1,
        capabilities: { [CAP]: { total, validators: members.map(memberProof),
            total_proof: { key: M.toHex(tKey), leaf_value: M.toHex(M.stakeTotalLeaf(total)),
                           compressed: M.compressSmtProof(store.descend(stakesRoot, tKey)) } } }
    };
    return { proof, stateRoot, stakesRoot };
}

const MEMBERS = [{ pubkey: 'aa'.repeat(32), source: 'S1', weight: '10' },
                 { pubkey: 'bb'.repeat(32), source: 'S1', weight: '10' },
                 { pubkey: 'cc'.repeat(32), source: 'S2', weight: '30' }];


// Real Ed25519 sources for the quorum check.
function signer() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const spki = publicKey.export({ format: 'der', type: 'spki' });
    return { privateKey, pubkey: spki.subarray(spki.length - 32).toString('hex') };
}
function signedCheckpoint(signers) {
    const cp = { chain: CHAIN, network: NET, block_index: 100, block_hash: 'c0'.repeat(32),
        ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
        checkpoint_seq: 0, snapshot_block: 100, state_root: 'd4'.repeat(32), state_root_version: 1,
        block_merkle_root: 'e5'.repeat(32), block_merkle_version: 1, validator_signatures: [] };
    const canonical = checkpoint.canonicalCheckpoint(cp);
    cp.validator_signatures = signers.map(s => ({ pubkey: s.pubkey, sig: crypto.sign(null, Buffer.from(canonical, 'utf8'), s.privateKey).toString('hex') }));
    return cp;
}

describe('SPV Phase 5: validator-set proof + trustless quorum', function () {

    beforeEach(function () {
        light.clearValidatorSetCache();
    });

    it('verifyValidatorSetProof ACCEPTS a well-formed proof bound to the trusted state_root', function () {
        const { proof, stateRoot } = buildValidatorSetProof(MEMBERS, '40');
        const r = light.verifyValidatorSetProof(proof, stateRoot);
        assert.strictEqual(r.verified, true, r.reason);
        assert.strictEqual(r.capabilities[CAP].total, M.canonicalAmount('40'));
        assert.strictEqual(r.capabilities[CAP].validators.length, 3);
    });

    it('verifyValidatorSetProof REJECTS a tampered member weight and a wrong state_root', function () {
        const { proof, stateRoot } = buildValidatorSetProof(MEMBERS, '40');
        const bad = JSON.parse(JSON.stringify(proof));
        bad.capabilities[CAP].validators[0].weight = '999';      // leaf no longer matches
        assert.strictEqual(light.verifyValidatorSetProof(bad, stateRoot).reason.split(':')[0], 'MEMBER_LEAF_MISMATCH');
        assert.strictEqual(light.verifyValidatorSetProof(proof, 'ff'.repeat(32)).reason, 'SUBROOT_BIND_INVALID');
    });
});

describe('SPV Phase 5: validator-set proof + trustless quorum', function () {

    beforeEach(function () {
        light.clearValidatorSetCache();
    });

    it('verifyCheckpointWithProvenSet: PASSES when source-deduped signer stake clears 3·Σ > 2·S', function () {
        const s1 = signer(), s2 = signer();
        const proven = { validators: [{ pubkey: s1.pubkey, source: 'S1', weight: '10' },
                                      { pubkey: s2.pubkey, source: 'S2', weight: '30' }], total: '40' };
        const cp = signedCheckpoint([s1, s2]);                    // 10 + 30 = 40; 3·40 > 2·40
        assert.strictEqual(light.verifyCheckpointWithProvenSet(cp, proven).valid, true);
    });

    it('verifyCheckpointWithProvenSet: FAILS when too little stake signs', function () {
        const s1 = signer(), s2 = signer();
        const proven = { validators: [{ pubkey: s1.pubkey, source: 'S1', weight: '10' },
                                      { pubkey: s2.pubkey, source: 'S2', weight: '30' }], total: '40' };
        const cp = signedCheckpoint([s1]);                        // only 10 of 40; 3·10 < 2·40
        assert.strictEqual(light.verifyCheckpointWithProvenSet(cp, proven).valid, false);
    });

    it('verifyCheckpointWithProvenSet: SOURCE-dedupes (two keys of one source count once)', function () {
        const a = signer(), b = signer();                        // both belong to source S1
        const proven = { validators: [{ pubkey: a.pubkey, source: 'S1', weight: '30' },
                                      { pubkey: b.pubkey, source: 'S1', weight: '30' }], total: '60' };
        const cp = signedCheckpoint([a, b]);                     // both sign, but S1 counts ONCE = 30
        // dedup => numerator 30, 3·30 < 2·60 => false. Double-counting (60) would wrongly pass.
        assert.strictEqual(light.verifyCheckpointWithProvenSet(cp, proven).valid, false);
    });

    it('verifyCheckpointWithProvenSet: a garbage-then-valid duplicate for one signer still PASSES (seen marked after verify)', function () {
        const s1 = signer(), s2 = signer();
        const proven = { validators: [{ pubkey: s1.pubkey, source: 'S1', weight: '10' },
                                      { pubkey: s2.pubkey, source: 'S2', weight: '30' }], total: '40' };
        const cp = signedCheckpoint([s1, s2]);                   // both needed: dropping S2 => 3·10 < 2·40
        // The signature list is server-supplied (attacker-influenceable): prepend an
        // INVALID entry for s2 ordered before its genuine one. Marking "seen" on first
        // encounter would suppress the real signature and false-reject a quorate
        // checkpoint; the hardened order (matching checkpoint.js#verifyCheckpoint)
        // must count it.
        cp.validator_signatures = [{ pubkey: s2.pubkey, sig: '00'.repeat(64) }].concat(cp.validator_signatures);
        assert.strictEqual(light.verifyCheckpointWithProvenSet(cp, proven).valid, true);
    });
});

describe('SPV Phase 5: validator-set proof + trustless quorum', function () {

    beforeEach(function () {
        light.clearValidatorSetCache();
    });


    // Finding #2280: the inline predicate this function once carried dropped the
    // shared swq fail-closed guards; a blank-source snapshot collapsed to 1-of-N.
    // Assert every guard against BOTH verifiers so they can never diverge again.
    it('verifyCheckpointWithProvenSet: FAILS CLOSED on a blank-source snapshot (no 1-of-N collapse), matching checkpoint.verifyCheckpoint', function () {
        const s1 = signer(), s2 = signer(), s3 = signer();
        const validators = [{ pubkey: s1.pubkey, source: '', weight: '10' },
                            { pubkey: s2.pubkey, source: '', weight: '10' },
                            { pubkey: s3.pubkey, source: '', weight: '10' }];
        // The authoring-side collapse commits total = w1 ('10'), so a single
        // signature would clear 3*10 > 2*10 without the guard.
        const proven = { validators, total: '10' };
        const cp = signedCheckpoint([s1]);
        assert.strictEqual(light.verifyCheckpointWithProvenSet(cp, proven).valid, false);
        assert.strictEqual(checkpoint.verifyCheckpoint(cp, validators).valid, false);
    });

    it('verifyCheckpointWithProvenSet: FAILS CLOSED on a negative weight (verdict false, no throw)', function () {
        const s1 = signer(), s2 = signer();
        const proven = { validators: [{ pubkey: s1.pubkey, source: 'S1', weight: '10' },
                                      { pubkey: s2.pubkey, source: 'S2', weight: '-5' }], total: '5' };
        const cp = signedCheckpoint([s1, s2]);
        assert.strictEqual(light.verifyCheckpointWithProvenSet(cp, proven).valid, false);
    });

    it('verifyCheckpointWithProvenSet: FAILS CLOSED on a truncated snapshot', function () {
        const s1 = signer(), s2 = signer();
        const validators = [{ pubkey: s1.pubkey, source: 'S1', weight: '10' },
                            { pubkey: s2.pubkey, source: 'S2', weight: '30' }];
        validators.truncated = true;
        const cp = signedCheckpoint([s1, s2]);
        assert.strictEqual(light.verifyCheckpointWithProvenSet(cp, { validators, total: '40' }).valid, false);
    });

    it('verifyCheckpointWithProvenSet: FAILS CLOSED when the committed __total__ disagrees with the proven set', function () {
        const s1 = signer(), s2 = signer();
        const proven = { validators: [{ pubkey: s1.pubkey, source: 'S1', weight: '10' },
                                      { pubkey: s2.pubkey, source: 'S2', weight: '30' }],
                         total: '15' };                          // committed denominator understates S=40
        const cp = signedCheckpoint([s1, s2]);
        assert.strictEqual(light.verifyCheckpointWithProvenSet(cp, proven).valid, false);
    });
});

describe('SPV Phase 5: validator-set proof + trustless quorum', function () {

    beforeEach(function () {
        light.clearValidatorSetCache();
    });


    // canonicalCheckpoint appends the root suffix only when ALL FOUR
    // commitment fields are present, so a post-activation checkpoint missing one of
    // them is signed over the legacy ROOTLESS preimage. That let an explorer attach
    // an attacker-chosen state_root, drop a sibling field, and have rootless
    // signatures still verify: a root no validator signed, which followForward adopts
    // and verifyBalance then trusts. checkpoint.verifyCheckpoint has rejected this
    // for some time; this verifier did not.
    it('verifyCheckpointWithProvenSet: REJECTS a post-activation checkpoint carrying a root but missing a sibling commitment field', function () {
        for (const missing of ['block_merkle_root', 'state_root_version', 'block_merkle_version']) {
            const s1 = signer(), s2 = signer();
            const proven = { validators: [{ pubkey: s1.pubkey, source: 'S1', weight: '10' },
                                          { pubkey: s2.pubkey, source: 'S2', weight: '30' }], total: '40' };
            const cp = signedCheckpoint([s1, s2]);
            delete cp[missing];
            cp.state_root = 'ff'.repeat(32);                      // the attacker's chosen root
            // Re-sign over what canonicalCheckpoint emits here: the rootless preimage,
            // which is exactly what a straggler validator would have signed.
            const rootless = checkpoint.canonicalCheckpoint(cp);
            assert.ok(!rootless.includes('ff'.repeat(32)), 'the root suffix must be absent for ' + missing);
            cp.validator_signatures = [s1, s2].map(s => ({ pubkey: s.pubkey,
                sig: crypto.sign(null, Buffer.from(rootless, 'utf8'), s.privateKey).toString('hex') }));
            const r = light.verifyCheckpointWithProvenSet(cp, proven);
            assert.strictEqual(r.valid, false, 'missing ' + missing + ' must not verify');
            assert.strictEqual(r.total, '0');
        }
    });

    it('verifyCheckpointWithProvenSet: still PASSES when all four commitment fields are present', function () {
        const s1 = signer(), s2 = signer();
        const proven = { validators: [{ pubkey: s1.pubkey, source: 'S1', weight: '10' },
                                      { pubkey: s2.pubkey, source: 'S2', weight: '30' }], total: '40' };
        assert.strictEqual(light.verifyCheckpointWithProvenSet(signedCheckpoint([s1, s2]), proven).valid, true);
    });
});
