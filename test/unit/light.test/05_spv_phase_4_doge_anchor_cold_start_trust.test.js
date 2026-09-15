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
// One SIGNED v0 section (state_root threaded in so it can bind a balance proof),
// returned as the checkpoint object, the section's wire fragment, the explorer
// section row and the qualifying validator set. `network` is a parameter so the
// header-network rule can be exercised: the signature covers the canonical built
// with THIS network, and the wire fragment never carries it.
function makeSignedSection(opts) {
    opts = opts || {};
    const chain = opts.chain || CHAIN;
    const net   = opts.network || NET;
    const signer = makeSigner();
    const cp = {
        chain, network: net, block_index: 100, block_hash: 'c0'.repeat(32),
        ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
        checkpoint_seq: (opts.seq != null ? opts.seq : 7), snapshot_block: 100,
        state_root: opts.stateRoot || ('d4'.repeat(32)), state_root_version: 1,
        block_merkle_root: 'e5'.repeat(32), block_merkle_version: 1, validator_signatures: []
    };
    const canonical = checkpoint.canonicalCheckpoint(cp);
    const sigs = [{ pubkey: signer.pubkeyHex, sig: crypto.sign(null, Buffer.from(canonical, 'utf8'), signer.privateKey).toString('hex') }];
    cp.validator_signatures = sigs;
    const validators = [{ pubkey: signer.pubkeyHex, source: signer.pubkeyHex, weight: '100' }];
    // A section omits NETWORK (§2.1): it is carried once, in the bundle header.
    const fields = [cp.chain, cp.block_index, cp.block_hash, cp.ledger_hash, cp.actions_hash,
        cp.contract_hash, cp.checkpoint_seq, cp.snapshot_block, cp.state_root, cp.state_root_version,
        cp.block_merkle_root, cp.block_merkle_version, sigs.length, sigs[0].pubkey, sigs[0].sig];
    // The explorer serves one row PER SECTION, each carrying the header network.
    const record = {
        version: 0, chain: cp.chain, network: cp.network, block_index: cp.block_index, block_hash: cp.block_hash,
        ledger_hash: cp.ledger_hash, actions_hash: cp.actions_hash, contract_hash: cp.contract_hash,
        checkpoint_seq: cp.checkpoint_seq, snapshot_block: cp.snapshot_block,
        state_root: cp.state_root, state_root_version: cp.state_root_version,
        block_merkle_root: cp.block_merkle_root, block_merkle_version: cp.block_merkle_version,
        validator_signatures: JSON.stringify(sigs),
        block_index_doge: (opts.dogeBlock != null ? opts.dogeBlock : 1000), tx_hash: 'dd'.repeat(32)
    };
    return { cp, sigs, validators, fields, record };
}

describe('SPV Phase 4: DOGE-anchor cold-start trust', function () {

    beforeEach(function () {
        light.clearValidatorSetCache();
    });


    // The explorer's block_index_doge is its own unverified claim about where its
    // anchor tx landed, so a hostile explorer can mint any depth it wants and the
    // buried-anchor gate proves nothing. These pin the caller-sourced height tier.
    it('fetchAnchoredCheckpoint prefers the caller DOGE tx height over the explorer claim', async function () {
        const a = makeSignedSection({ dogeBlock: 1000 });
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
        const a = makeSignedSection({ dogeBlock: 1000 });
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
});

describe('SPV Phase 4: DOGE-anchor cold-start trust', function () {

    beforeEach(function () {
        light.clearValidatorSetCache();
    });


    // The anchor cold start resolves its signer set through the SAME documented
    // ladder as verifyBalance/verifyLockedBalance/verifyAction (light-client.md
    // "Trust roots": explicit -> pinned -> explorer /verify). Verifying against an
    // empty set instead is not a neutral no-op: verifyCheckpoint reads
    // qualified.size 0 as quorum 1, weighted true, hasWeights false, so it returns
    // CHECKPOINT_QUORUM_FAILED on a checkpoint the same explorer's set clears
    // (measured against the public testnet explorer 2026-08-28: quorum 1, nsigs 4,
    // against a server-reported verified true at quorum 3).
    //
    // `targetCoin` is what the ladder keys on here: the anchor list is read off the
    // DOGE explorer, but the checkpoint inside it belongs to the target chain, so
    // the /verify fetch has to name the TARGET chain's coin prefix.
    it('fetchAnchoredCheckpoint with no validators falls through to the documented trust ladder', async function () {
        const a = makeSignedSection({ dogeBlock: 1000 });
        const seen = [];
        const fetchImpl = async (url) => {
            seen.push(url);
            if (url.includes('/api/anchors/'))
                return { ok: true, status: 200, json: async () => ({ data: [a.record] }) };
            // Tier 3, exactly the shape the live explorer serves at
            // /<coin>/api/checkpoint/<block_index>/verify: {pubkey, weight, source}.
            if (url.includes('/api/checkpoint/'))
                return { ok: true, status: 200, json: async () => ({ validators: a.validators }) };
            return { ok: false, status: 404, json: async () => ({}) };
        };
        // Control: the identical call WITH the set verifies, so nothing else in the
        // fixture (depth, roots, signatures) is what fails below.
        const withSet = await light.fetchAnchoredCheckpoint({ explorerUrl: 'https://x', dogeCoin: 'DOGE',
            targetChain: CHAIN, validators: a.validators, dogeTipHeight: 1200, minDepth: 60, fetchImpl });
        assert.strictEqual(withSet.verified, true, withSet.reason);
        const r = await light.fetchAnchoredCheckpoint({ explorerUrl: 'https://x', dogeCoin: 'DOGE',
            targetChain: CHAIN, targetCoin: COIN, dogeTipHeight: 1200, minDepth: 60, fetchImpl });
        assert.ok(seen.some(u => u.includes('/api/checkpoint/')),
            'no set was supplied, so the convenience tier must resolve one; instead an EMPTY set was verified');
        assert.strictEqual(r.verified, true, r.reason);
    });
});

describe('SPV Phase 4: DOGE-anchor cold-start trust', function () {

    beforeEach(function () {
        light.clearValidatorSetCache();
    });

    it('fetchAnchoredCheckpoint tier 3 asks the TARGET chain coin, not the DOGE coin', async function () {
        // The wrinkle the ladder has to survive: dogeCoin names the chain the ANCHOR
        // sits on, targetCoin the chain the CHECKPOINT belongs to. Asking DOGE for an
        // LTC checkpoint's signer set is a different question with a different answer.
        const a = makeSignedSection({ chain: 'LTC', dogeBlock: 1000 });
        const verifyUrls = [];
        const fetchImpl = async (url) => {
            if (url.includes('/api/anchors/'))
                return { ok: true, status: 200, json: async () => ({ data: [a.record] }) };
            if (url.includes('/api/checkpoint/')) {
                verifyUrls.push(url);
                return { ok: true, status: 200, json: async () => ({ validators: a.validators }) };
            }
            return { ok: false, status: 404, json: async () => ({}) };
        };
        const r = await light.fetchAnchoredCheckpoint({ explorerUrl: 'https://x', dogeCoin: 'TDOGE',
            targetChain: 'LTC', targetCoin: 'TLTC', dogeTipHeight: 1200, minDepth: 60, fetchImpl });
        assert.strictEqual(r.verified, true, r.reason);
        assert.deepStrictEqual(verifyUrls, ['https://x/TLTC/api/checkpoint/100/verify']);
    });

    it('fetchAnchoredCheckpoint tier 1: an explicit set wins and never calls /verify', async function () {
        const a = makeSignedSection({ dogeBlock: 1000 });
        const seen = [];
        const fetchImpl = async (url) => {
            seen.push(url);
            if (url.includes('/api/anchors/'))
                return { ok: true, status: 200, json: async () => ({ data: [a.record] }) };
            return { ok: false, status: 404, json: async () => ({}) };
        };
        // targetCoin present too, so the absence of a /verify call is the explicit
        // set winning and not a missing coin prefix.
        const r = await light.fetchAnchoredCheckpoint({ explorerUrl: 'https://x', dogeCoin: 'DOGE',
            targetChain: CHAIN, targetCoin: COIN, validators: a.validators,
            dogeTipHeight: 1200, minDepth: 60, fetchImpl });
        assert.strictEqual(r.verified, true, r.reason);
        assert.ok(!seen.some(u => u.includes('/api/checkpoint/')), 'tier 1 must not consult the explorer for the set');
    });
});

describe('SPV Phase 4: DOGE-anchor cold-start trust', function () {

    beforeEach(function () {
        light.clearValidatorSetCache();
    });

    it('fetchAnchoredCheckpoint tier 2: a pinned set wins over the explorer', async function () {
        // Same no-silent-downgrade rule the proof paths follow: with an entry pinned
        // for the target coin, /verify is never called.
        const a = makeSignedSection({ dogeBlock: 1000 });
        const seen = [], askedFor = [];
        const fetchImpl = async (url) => {
            seen.push(url);
            if (url.includes('/api/anchors/'))
                return { ok: true, status: 200, json: async () => ({ data: [a.record] }) };
            // A hostile explorer offers a set that would NOT verify this checkpoint.
            if (url.includes('/api/checkpoint/'))
                return { ok: true, status: 200, json: async () => ({ validators: [{ pubkey: 'ff'.repeat(32), source: 'ff'.repeat(32), weight: '100' }] }) };
            return { ok: false, status: 404, json: async () => ({}) };
        };
        const r = await light.fetchAnchoredCheckpoint({ explorerUrl: 'https://x', dogeCoin: 'DOGE',
            targetChain: CHAIN, targetCoin: COIN, dogeTipHeight: 1200, minDepth: 60, fetchImpl,
            pinnedResolver: (coin) => { askedFor.push(coin); return { checkpoint: a.cp, validators: a.validators }; } });
        assert.deepStrictEqual(askedFor, [COIN], 'the pinned lookup keys on the TARGET coin');
        assert.strictEqual(r.verified, true, r.reason);
        assert.ok(!seen.some(u => u.includes('/api/checkpoint/')), 'a pinned coin must not be downgraded to the explorer set');
    });

    it('fetchAnchoredCheckpoint FAILS CLOSED when no tier can resolve a set', async function () {
        // Nothing maps a chain plus network back to a coin prefix, so with no explicit
        // set, nothing pinned and no targetCoin there is no set to resolve. Refuse,
        // rather than guess a prefix or verify against an empty set.
        const a = makeSignedSection({ dogeBlock: 1000 });
        const seen = [];
        const fetchImpl = async (url) => {
            seen.push(url);
            if (url.includes('/api/anchors/'))
                return { ok: true, status: 200, json: async () => ({ data: [a.record] }) };
            if (url.includes('/api/checkpoint/'))
                return { ok: true, status: 200, json: async () => ({ validators: a.validators }) };
            return { ok: false, status: 404, json: async () => ({}) };
        };
        const r = await light.fetchAnchoredCheckpoint({ explorerUrl: 'https://x', dogeCoin: 'DOGE',
            targetChain: CHAIN, dogeTipHeight: 1200, minDepth: 60, fetchImpl });
        assert.strictEqual(r.verified, false);
        assert.strictEqual(r.reason, 'CHECKPOINT_QUORUM_FAILED');
        assert.ok(!seen.some(u => u.includes('/api/checkpoint/')),
            'with no coin prefix there is no /verify URL to build, so none may be guessed');
    });
});

describe('SPV Phase 4: DOGE-anchor cold-start trust', function () {

    beforeEach(function () {
        light.clearValidatorSetCache();
    });

    it('fetchAnchoredCheckpoint still REJECTS a resolved set that does not meet quorum', async function () {
        // The ladder resolves a set; it does not bless one. An explorer that names a
        // set which did not sign this checkpoint must still fail quorum.
        const a = makeSignedSection({ dogeBlock: 1000 });
        const other = makeSignedSection({ dogeBlock: 1000 });
        const fetchImpl = async (url) => {
            if (url.includes('/api/anchors/'))
                return { ok: true, status: 200, json: async () => ({ data: [a.record] }) };
            if (url.includes('/api/checkpoint/'))
                return { ok: true, status: 200, json: async () => ({ validators: other.validators }) };
            return { ok: false, status: 404, json: async () => ({}) };
        };
        const r = await light.fetchAnchoredCheckpoint({ explorerUrl: 'https://x', dogeCoin: 'DOGE',
            targetChain: CHAIN, targetCoin: COIN, dogeTipHeight: 1200, minDepth: 60, fetchImpl });
        assert.strictEqual(r.verified, false);
        assert.strictEqual(r.reason, 'CHECKPOINT_QUORUM_FAILED');
        assert.strictEqual(r.quorum, 1);                        // a 1-entry set, no signature of it valid
    });

    it('a DOGE-anchored checkpoint then binds a balance proof via trustedCheckpoint', async function () {
        const { proof, stateRoot } = buildBalanceProof(ADDR_A, TICK, '7');
        const a = makeSignedSection({ stateRoot, dogeBlock: 1000 });
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
        const a = makeSignedSection({ stateRoot: 'd4'.repeat(32), dogeBlock: 1000 });
        a.cp.block_index = 999;                                   // trusted checkpoint at a different height
        const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ proof }) });
        const r = await light.verifyBalance({ explorerUrl: 'https://x', coin: COIN, address: ADDR_A,
            tick: TICK, atHeight: 100, trustedCheckpoint: a.cp, fetchImpl });
        assert.strictEqual(r.verified, false);
        assert.strictEqual(r.reason, 'PROOF_HEIGHT_MISMATCH');
    });
});
