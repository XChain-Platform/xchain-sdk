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

describe('SPV Phase 4: DOGE-anchor cold-start trust', function () {

    function makeSigner() {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
        const spki = publicKey.export({ format: 'der', type: 'spki' });
        return { privateKey, pubkeyHex: spki.subarray(spki.length - 32).toString('hex') };
    }
    // A v3-anchored checkpoint (state_root threaded in so it can bind a balance proof),
    // returned as the checkpoint object, a signed wire string, an explorer record, and
    // the qualifying validator set.
    function makeSignedV3(stateRoot, dogeBlock) {
        const signer = makeSigner();
        const cp = {
            chain: CHAIN, network: NET, block_index: 100, block_hash: 'c0'.repeat(32),
            ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
            checkpoint_seq: 7, snapshot_block: 100,
            state_root: stateRoot || ('d4'.repeat(32)), state_root_version: 1,
            block_merkle_root: 'e5'.repeat(32), block_merkle_version: 1, validator_signatures: []
        };
        const canonical = checkpoint.canonicalCheckpoint(cp);
        const sigs = [{ pubkey: signer.pubkeyHex, sig: crypto.sign(null, Buffer.from(canonical, 'utf8'), signer.privateKey).toString('hex') }];
        cp.validator_signatures = sigs;
        const validators = [{ pubkey: signer.pubkeyHex, source: signer.pubkeyHex, weight: '100' }];
        const wire = ['3', cp.chain, cp.network, cp.block_index, cp.block_hash, cp.ledger_hash, cp.actions_hash,
            cp.contract_hash, cp.checkpoint_seq, cp.snapshot_block, cp.state_root, cp.state_root_version,
            cp.block_merkle_root, cp.block_merkle_version, sigs.length, sigs[0].pubkey, sigs[0].sig].join('|');
        const record = {
            version: 3, chain: cp.chain, network: cp.network, block_index: cp.block_index, block_hash: cp.block_hash,
            ledger_hash: cp.ledger_hash, actions_hash: cp.actions_hash, contract_hash: cp.contract_hash,
            checkpoint_seq: cp.checkpoint_seq, snapshot_block: cp.snapshot_block,
            state_root: cp.state_root, state_root_version: cp.state_root_version,
            block_merkle_root: cp.block_merkle_root, block_merkle_version: cp.block_merkle_version,
            validator_signatures: JSON.stringify(sigs), block_index_doge: (dogeBlock != null ? dogeBlock : 1000), tx_hash: 'dd'.repeat(32)
        };
        return { cp, sigs, validators, wire, record };
    }

    it('parseAnchorV3 round-trips a v3 wire into a quorum-verifiable checkpoint', function () {
        const { wire, validators } = makeSignedV3();
        const cp = light.parseAnchorV3(wire);
        assert.strictEqual(cp.chain, CHAIN);
        assert.strictEqual(cp.state_root_version, 1);
        assert.strictEqual(cp.validator_signatures.length, 1);
        assert.strictEqual(checkpoint.verifyCheckpoint(cp, validators).valid, true);
    });

    it('parseAnchorV3 tolerates a leading ANCHOR| and rejects non-v3', function () {
        const { wire } = makeSignedV3();
        assert.strictEqual(light.parseAnchorV3('ANCHOR|' + wire).checkpoint_seq, 7);
        assert.throws(() => light.parseAnchorV3('0|BTC|regtest|1'), /not a v3 ANCHOR/);
    });

    it('verifyAnchoredCheckpoint ACCEPTS a quorum-signed anchor buried past minDepth', function () {
        const { cp, validators } = makeSignedV3();
        const r = light.verifyAnchoredCheckpoint({ checkpoint: cp, validators, confirmations: 120, minDepth: 60 });
        assert.strictEqual(r.verified, true, r.reason);
        assert.strictEqual(r.confirmations, 120);
    });

    it('verifyAnchoredCheckpoint REJECTS an anchor too shallow on DOGE', function () {
        const { cp, validators } = makeSignedV3();
        const r = light.verifyAnchoredCheckpoint({ checkpoint: cp, validators, confirmations: 5, minDepth: 60 });
        assert.strictEqual(r.verified, false);
        assert.strictEqual(r.reason, 'INSUFFICIENT_DOGE_DEPTH');
    });

    it('verifyAnchoredCheckpoint REJECTS a rootless (non-v3) checkpoint', function () {
        const { cp, validators } = makeSignedV3();
        cp.state_root = null; cp.block_merkle_root = null;
        const r = light.verifyAnchoredCheckpoint({ checkpoint: cp, validators, confirmations: 120 });
        assert.strictEqual(r.reason, 'NOT_A_V3_ANCHOR');
    });

    it('fetchAnchoredCheckpoint picks the newest v3 anchor and verifies depth + quorum', async function () {
        const a = makeSignedV3(null, 1000);
        // an older, lower-seq anchor that should be ignored in favor of the newest
        const fetchImpl = async (url) => {
            if (url.includes('/api/anchors/'))
                return { ok: true, status: 200, json: async () => ({ data: [
                    Object.assign({}, a.record, { checkpoint_seq: 3, block_index_doge: 500 }),
                    a.record
                ] }) };
            return { ok: false, status: 404, json: async () => ({}) };
        };
        const r = await light.fetchAnchoredCheckpoint({ explorerUrl: 'https://x', dogeCoin: 'DOGE',
            targetChain: CHAIN, validators: a.validators, dogeTipHeight: 1200, minDepth: 60, fetchImpl });
        assert.strictEqual(r.verified, true, r.reason);
        assert.strictEqual(r.checkpoint.checkpoint_seq, 7);     // newest, not the seq-3 decoy
        assert.strictEqual(r.confirmations, 201);               // 1200 - 1000 + 1
        assert.strictEqual(r.dogeTxid, 'dd'.repeat(32));
    });

    it('a DOGE-anchored checkpoint then binds a balance proof via trustedCheckpoint', async function () {
        const { proof, stateRoot } = buildBalanceProof(ADDR_A, TICK, '7');
        const a = makeSignedV3(stateRoot, 1000);
        const anchored = light.verifyAnchoredCheckpoint({ checkpoint: a.cp, validators: a.validators, confirmations: 300, minDepth: 60 });
        assert.strictEqual(anchored.verified, true, anchored.reason);
        // No validators / no verify-endpoint fetch: the trusted checkpoint carries the trust.
        const fetchImpl = async (url) => url.includes('/api/proof/balance/')
            ? { ok: true, status: 200, json: async () => ({ proof }) }
            : { ok: false, status: 500, json: async () => ({}) };
        const r = await light.verifyBalance({ explorerUrl: 'https://x', coin: COIN, address: ADDR_A,
            tick: TICK, atHeight: 100, trustedCheckpoint: anchored.checkpoint, fetchImpl });
        assert.strictEqual(r.verified, true, r.reason);
        assert.strictEqual(r.amount, M.canonicalAmount('7'));
    });

    it('trustedCheckpoint rejects a proof for the wrong height (PROOF_HEIGHT_MISMATCH)', async function () {
        const { proof } = buildBalanceProof(ADDR_A, TICK, '7');   // proof.height = 100
        const a = makeSignedV3('d4'.repeat(32), 1000);
        a.cp.block_index = 999;                                   // trusted checkpoint at a different height
        const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ proof }) });
        const r = await light.verifyBalance({ explorerUrl: 'https://x', coin: COIN, address: ADDR_A,
            tick: TICK, atHeight: 100, trustedCheckpoint: a.cp, fetchImpl });
        assert.strictEqual(r.verified, false);
        assert.strictEqual(r.reason, 'PROOF_HEIGHT_MISMATCH');
    });
});

describe('SPV Phase 5: validator-set proof + trustless quorum', function () {

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
});
