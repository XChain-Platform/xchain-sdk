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

    // ---- binding a proof to the REQUESTED identity, not just the echoed one ----
    // Every verifier re-derives its SMT key from fields carried IN the proof, so a
    // valid proof for a DIFFERENT question passes. The explorer's contract-state
    // double-decode made that happen for real ( frontier, 2026-08-06): a
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
        // ...and the honest answer still verifies against the same expectation.
        const honest = buildContractStateProof(7, 'a%41b', '"v"');
        assert.strictEqual(light.verifyContractStateProof(honest.proof, honest.stateRoot, CHAIN, NET,
                                                          { contract_index: 7, state_key: 'a%41b' }).verified, true);
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

    // ---- verifyLockedBalanceProof (XCHAIN_ESC, SPV sub-tree spec §3 Stage B) ----
    // A locked proof is a balance proof in a second key domain of the SAME
    // balances_root, so the builder just swaps the key derivation. The extra
    // rule under test is LIVENESS: the SDK's own activation carrier decides
    // whether the domain is committed at the proof's height, whatever the
    // server said, because no proof can tell (an armed-but-idle domain and an
    // inert one commit byte-identical roots).
    const SUBACT = require('../../src/state_subtree_activation.js');
    const ESC_KEY = CHAIN + ':' + NET;
    // BTC:regtest carries a REAL armed height now, so "disarm" must not DELETE the key:
    // that silently wipes the fleet-armed set for every later test in the process, and
    // it is the third place this trap has appeared across the two armings. Disarming
    // instead pushes the threshold out of reach, which is inert at every height a test
    // uses while leaving the key present, and the real value is put back afterwards.
    const ESC_HAD   = Object.prototype.hasOwnProperty.call(SUBACT.ESCROW_LOCKED_LEAF_ACTIVATION, ESC_KEY);
    const ESC_PRIOR = SUBACT.ESCROW_LOCKED_LEAF_ACTIVATION[ESC_KEY];
    function armEsc() { SUBACT.ESCROW_LOCKED_LEAF_ACTIVATION[ESC_KEY] = 0; }
    function disarmEsc() { SUBACT.ESCROW_LOCKED_LEAF_ACTIVATION[ESC_KEY] = Number.MAX_SAFE_INTEGER; }
    after(function(){
        if(ESC_HAD) SUBACT.ESCROW_LOCKED_LEAF_ACTIVATION[ESC_KEY] = ESC_PRIOR;
        else delete SUBACT.ESCROW_LOCKED_LEAF_ACTIVATION[ESC_KEY];
    });

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

    it('verifyLockedBalanceProof REJECTS a spendable-domain proof (KEY_MISMATCH both ways)', function () {
        armEsc();
        try {
            const spend  = buildBalanceProof(ADDR_A, TICK, '5');
            const locked = buildLockedProof(ADDR_A, TICK, '7');
            assert.strictEqual(light.verifyLockedBalanceProof(spend.proof, spend.stateRoot, CHAIN, NET).reason, 'KEY_MISMATCH');
            assert.strictEqual(light.verifyBalanceProof(locked.proof, locked.stateRoot, CHAIN, NET).reason, 'KEY_MISMATCH');
        } finally { disarmEsc(); }
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
    // label a drifted or hostile explorer can set at will. Until  the binding
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

    it('parseAnchorV3 tolerates a leading ANCHOR| and rejects rootless (v0/v4) anchors', function () {
        const { wire } = makeSignedV3();
        assert.strictEqual(light.parseAnchorV3('ANCHOR|' + wire).checkpoint_seq, 7);
        assert.throws(() => light.parseAnchorV3('0|BTC|regtest|1'), /not a root-bearing ANCHOR/);
        assert.throws(() => light.parseAnchorV3('4|BTC|regtest|1'), /not a root-bearing ANCHOR/);
    });

    it('parseAnchorV3 also accepts a v5 wire, ignoring the publisher attestation tail', function () {
        const { wire, sigs, validators } = makeSignedV3();
        // v5 = the v3 wire with VERSION 5 plus a trailing PUBLISHER + attestation list. The
        // roots and SIG_COUNT sit at the same positions, so the tail is parsed-past and the
        // SPV checkpoint is byte-identical to the v3 form (trust is the checkpoint quorum).
        const parts = wire.split('|');
        parts[0] = '5';
        const v5wire = parts.concat(['07'.repeat(32), '1', sigs[0].pubkey, sigs[0].sig]).join('|');
        const cp = light.parseAnchorV3(v5wire);
        assert.strictEqual(cp.checkpoint_seq, 7);
        assert.strictEqual(cp.state_root_version, 1);
        assert.strictEqual(cp.validator_signatures.length, 1);
        assert.strictEqual(checkpoint.verifyCheckpoint(cp, validators).valid, true);
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

    it('verifyAnchoredCheckpoint REJECTS roots the signature never covered', function () {
        // A legitimately signed ROOTLESS checkpoint: with the version fields absent,
        // canonicalCheckpoint omits the root suffix, so the quorum signs the legacy
        // canonical. Republishing it as a buried v3 with attacker-chosen roots used to
        // pass, because the old signature still verifies against that same canonical.
        const signer = makeSigner();
        const cp = {
            chain: CHAIN, network: NET, block_index: 100, block_hash: 'c0'.repeat(32),
            ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
            checkpoint_seq: 7, snapshot_block: 100,
            state_root: null, state_root_version: null,
            block_merkle_root: null, block_merkle_version: null, validator_signatures: []
        };
        const canonical = checkpoint.canonicalCheckpoint(cp);
        cp.validator_signatures = [{ pubkey: signer.pubkeyHex, sig: crypto.sign(null, Buffer.from(canonical, 'utf8'), signer.privateKey).toString('hex') }];
        const validators = [{ pubkey: signer.pubkeyHex, source: signer.pubkeyHex, weight: '100' }];
        // The signature is genuine and the quorum is real, but since  the base
        // verifier ALSO refuses a rootless row once the commitment is active, so this
        // attack is now blocked a layer earlier than the SPV checks below. Those checks
        // stay asserted: they are the backstop if the row ever reaches them.
        assert.strictEqual(checkpoint.verifyCheckpoint(cp, validators).valid, false);

        // Attack: graft roots on without the version fields, so the canonical (and
        // therefore the signature that covers it) is unchanged.
        cp.state_root = 'ff'.repeat(32);
        cp.block_merkle_root = 'ee'.repeat(32);
        const r = light.verifyAnchoredCheckpoint({ checkpoint: cp, validators, confirmations: 300, minDepth: 60 });
        assert.strictEqual(r.verified, false);
        assert.strictEqual(r.reason, 'ROOTS_NOT_SIGNED');

        // Supplying the versions too pulls the roots into the canonical, which the
        // old signature no longer matches: the attack fails on quorum instead.
        cp.state_root_version = 1; cp.block_merkle_version = 1;
        const r2 = light.verifyAnchoredCheckpoint({ checkpoint: cp, validators, confirmations: 300, minDepth: 60 });
        assert.strictEqual(r2.verified, false);
        assert.strictEqual(r2.reason, 'CHECKPOINT_QUORUM_FAILED');
    });

    it('verifyAnchoredCheckpoint REJECTS a root that is not a 32-byte hex value', function () {
        const { cp, validators } = makeSignedV3();
        cp.state_root = 'not-a-root';
        const r = light.verifyAnchoredCheckpoint({ checkpoint: cp, validators, confirmations: 300, minDepth: 60 });
        assert.strictEqual(r.reason, 'MALFORMED_ROOT');
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

    it('fetchAnchoredCheckpoint accepts a v5 anchor record (post-flag-day root-bearing)', async function () {
        const a = makeSignedV3(null, 1000);
        a.record.version = 5;                                   // v5 row served by the explorer
        const fetchImpl = async (url) => url.includes('/api/anchors/')
            ? { ok: true, status: 200, json: async () => ({ data: [a.record] }) }
            : { ok: false, status: 404, json: async () => ({}) };
        const r = await light.fetchAnchoredCheckpoint({ explorerUrl: 'https://x', dogeCoin: 'DOGE',
            targetChain: CHAIN, validators: a.validators, dogeTipHeight: 1200, minDepth: 60, fetchImpl });
        assert.strictEqual(r.verified, true, r.reason);
        assert.strictEqual(r.checkpoint.checkpoint_seq, 7);
    });

    // The explorer's block_index_doge is its own unverified claim about where its
    // anchor tx landed, so a hostile explorer can mint any depth it wants and the
    // buried-anchor gate proves nothing. These pin the caller-sourced height tier.
    it('fetchAnchoredCheckpoint prefers the caller DOGE tx height over the explorer claim', async function () {
        const a = makeSignedV3(null, 1000);
        // Hostile explorer backdates its own anchor to fabricate a deep burial.
        a.record.block_index_doge = 1;
        const fetchImpl = async (url) => url.includes('/api/anchors/')
            ? { ok: true, status: 200, json: async () => ({ data: [a.record] }) }
            : { ok: false, status: 404, json: async () => ({}) };
        const seen = [];
        const r = await light.fetchAnchoredCheckpoint({ explorerUrl: 'https://x', dogeCoin: 'DOGE',
            targetChain: CHAIN, validators: a.validators, dogeTipHeight: 1010, minDepth: 60, fetchImpl,
            getDogeTxHeight: async (txid) => { seen.push(txid); return 1000; } });
        assert.deepStrictEqual(seen, ['dd'.repeat(32)], 'the anchor txid must be handed to the caller lookup');
        assert.strictEqual(r.depthSource, 'caller');
        assert.strictEqual(r.confirmations, 11);                // 1010 - 1000 + 1, not the forged 1010
        assert.strictEqual(r.verified, false);
        assert.strictEqual(r.reason, 'INSUFFICIENT_DOGE_DEPTH');
    });

    it('fetchAnchoredCheckpoint labels an explorer-sourced depth and requireTrustedDepth refuses it', async function () {
        const a = makeSignedV3(null, 1000);
        const fetchImpl = async (url) => url.includes('/api/anchors/')
            ? { ok: true, status: 200, json: async () => ({ data: [a.record] }) }
            : { ok: false, status: 404, json: async () => ({}) };
        const base = { explorerUrl: 'https://x', dogeCoin: 'DOGE', targetChain: CHAIN,
            validators: a.validators, dogeTipHeight: 1200, minDepth: 60, fetchImpl };
        const loose = await light.fetchAnchoredCheckpoint(base);
        assert.strictEqual(loose.verified, true, loose.reason);  // convenience tier unchanged
        assert.strictEqual(loose.depthSource, 'explorer');
        const strict = await light.fetchAnchoredCheckpoint(Object.assign({ requireTrustedDepth: true }, base));
        assert.strictEqual(strict.verified, false);
        assert.strictEqual(strict.reason, 'UNTRUSTED_DOGE_DEPTH');
        assert.strictEqual(strict.depthSource, 'explorer');
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

    // . canonicalCheckpoint appends the root suffix only when ALL FOUR
    // commitment fields are present, so a post-activation checkpoint missing one of
    // them is signed over the legacy ROOTLESS preimage. That let an explorer attach
    // an attacker-chosen state_root, drop a sibling field, and have rootless
    // signatures still verify: a root no validator signed, which followForward adopts
    // and verifyBalance then trusts. checkpoint.verifyCheckpoint has rejected this
    // since ; this verifier did not.
    it('verifyCheckpointWithProvenSet: REJECTS a post-activation checkpoint carrying a root but missing a sibling commitment field', function () {
        for (const missing of ['block_merkle_root', 'state_root_version', 'block_merkle_version']) {
            const s1 = signer(), s2 = signer();
            const proven = { validators: [{ pubkey: s1.pubkey, source: 'S1', weight: '10' },
                                          { pubkey: s2.pubkey, source: 'S2', weight: '30' }], total: '40' };
            const cp = signedCheckpoint([s1, s2]);
            delete cp[missing];
            cp.state_root = 'ff'.repeat(32);                      // the attacker's chosen root
            // Re-sign over what canonicalCheckpoint now emits: the rootless preimage,
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

describe('SPV D4: pinned launch trust root', function () {

    const pinned = require('../../src/pinnedCheckpoints.js');

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

describe('SPV §7.3: rotation-aware pinned path (followForward)', function () {

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

    // ── the followForward primitive itself (previously untested) ──────────────

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

    // ── verifyBalance / verifyAction roll the pinned root forward over rotation ──

    it('verifyBalance follows the pinned root forward to a rotated checkpoint and verifies (no /verify)', async function () {
        const launch = rsigner(), s1 = rsigner();               // launch set rotated OUT; s1 signs now
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
