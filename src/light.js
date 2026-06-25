/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain SDK - Light Client (SPV, spec §8)
 *
 * Verifies XChain facts (a balance, an action) without a full node, by checking
 * a compact Merkle proof against a quorum-signed checkpoint's committed roots.
 * The trust spine, in order:
 *   1. A checkpoint's signatures meet a stake-weighted `oracle_publish` quorum
 *      (sdk.checkpoint.verifyCheckpoint, pure local Ed25519).
 *   2. The proof recomputes the committed root with the merkle.js twin (the SAME
 *      module the indexer commits with and the explorer serves with).
 *   3. Nothing trusts the server's own `verified` / `amount`; only local
 *      recomputation against the quorum-signed root decides.
 *
 * The server (explorer) only transports proofs; it is never trusted. The
 * trust-minimized path supplies the qualifying validator set (`validators`) out
 * of band (a pinned launch set / a prior self-verified set); the convenience
 * path lets the explorer's verify endpoint supply it.
 *
 * Spec: claude/reports/SPV-LIGHT-CLIENT-SPEC.md §4.4, §5, §7, §8.
 *
 ********************************************************************/

'use strict';

const M          = require('./merkle.js');
const checkpoint = require('./checkpoint.js');
const pinned     = require('./pinnedCheckpoints.js');

function _fetch(impl){
    let f = impl || (typeof fetch === 'function' ? fetch : null);
    if (!f) throw new Error('LightClient: no fetch implementation available');
    return f;
}

// Pinned trust root (spec D4): when a caller supplies neither `validators` nor
// `trustedCheckpoint`, fall back to the out-of-band launch entry pinned for the
// target coin instead of trusting the explorer's /verify set. Returns null when
// nothing is pinned (the convenience path stands). The entry is
// { checkpoint, validators }: the launch checkpoint (committed state_root, the
// seed for rotation-following) plus the set that signed it. `pinnedResolver` is
// a test/override seam over the shipped registry.
function _pinnedEntry(opts){
    if (opts.validators || opts.trustedCheckpoint) return null;
    const resolve = opts.pinnedResolver || pinned.getPinnedCheckpoint;
    return resolve(opts.coin) || null;
}
function _base(u){ return String(u || '').replace(/\/+$/, ''); }
async function _json(f, url){
    let r = await f(url);
    if (!r.ok) throw new Error('LightClient: explorer returned HTTP ' + r.status);
    return r.json();
}
function _hx(x){ return String(x == null ? '' : x).toLowerCase(); }

// Default DOGE confirmation depth a cold-start anchor must be buried under before
// it is trusted. DOGE blocks ~1 min and ANCHORs land ~daily, so a recent valid
// anchor is normally far deeper than this; callers SHOULD set their own policy.
const DEFAULT_ANCHOR_MIN_DEPTH = 60;

// Verify a §4.4 BalanceProof binds to a TRUSTED state_root (one already proven to
// be in a quorum-signed checkpoint). chain/network come from the trusted
// checkpoint, never the proof. Returns { verified, amount, reason }.
function verifyBalanceProof(proof, trustedStateRoot, chain, network){
    try {
        if (!proof || !proof.smt_proof || !proof.sub_root_path) return _no('MALFORMED_PROOF');
        // The proven key must be exactly balanceKey(chain, network, address, tick):
        // a server cannot answer for (A,T) with a proof for some other key.
        const keyBuf    = M.balanceKey(chain, network, proof.address, proof.tick);
        if (_hx(proof.smt_proof.key) !== M.toHex(keyBuf)) return _no('KEY_MISMATCH');
        const leaf   = proof.smt_proof.leaf_value;             // hex string or null (non-inclusion)
        const amount = M.canonicalAmount(proof.amount);
        if (leaf == null){
            if (amount !== M.canonicalAmount('0')) return _no('NONINCLUSION_NONZERO_AMOUNT');
        } else {
            // The committed leaf must be exactly amountLeaf(amount): binds the
            // returned amount to the proof, so the server's `amount` cannot lie.
            if (M.toHex(M.amountLeaf(amount)) !== _hx(leaf)) return _no('LEAF_AMOUNT_MISMATCH');
        }
        // The SMT proof must reconstruct the claimed balances_root...
        if (!M.verifyCompressedSmtProof(proof.balances_root, keyBuf, leaf, proof.smt_proof.compressed))
            return _no('SMT_PROOF_INVALID');
        // ...and that balances_root must bind into the TRUSTED state_root via the
        // fixed 5-leaf sub-root path. A forged balances_root cannot bind here
        // (collision resistance), so the whole chain is anchored to the quorum.
        if (!M.verifyFixedMerkleProof(trustedStateRoot, M.toBuf(proof.balances_root),
                                      proof.sub_root_path.index, proof.sub_root_path.siblings))
            return _no('SUBROOT_BIND_INVALID');
        return { verified: true, amount, reason: null };
    } catch (e){ return _no('VERIFY_ERROR:' + (e && e.message)); }
}

// Verify a §5 action inclusion proof binds to a TRUSTED block_merkle_root.
// Returns { verified, reason }.
function verifyActionProof(proof, trustedBlockMerkleRoot){
    try {
        if (!proof || !proof.merkle_proof) return _no('MALFORMED_PROOF');
        // Recompute the action leaf from the proof's own fields: the server cannot
        // bind a leaf it did not also describe.
        const leaf = M.toHex(M.actionsLeaf({ action_index: proof.action_index,
            tx_index: proof.tx_index, action: (proof.action == null) ? '' : proof.action }));
        if (_hx(proof.leaf) !== leaf) return _no('LEAF_MISMATCH');
        if (!M.verifyFixedMerkleProof(trustedBlockMerkleRoot, M.toBuf(leaf),
                                      proof.merkle_proof.index, proof.merkle_proof.siblings))
            return _no('MERKLE_PROOF_INVALID');
        return { verified: true, reason: null };
    } catch (e){ return _no('VERIFY_ERROR:' + (e && e.message)); }
}

function _no(reason){ return { verified: false, amount: null, reason: reason }; }

// ── Trust: turn a server-served checkpoint into a quorum-verified one ──────────

// Establish that `cp` meets quorum. `validators` (the qualifying oracle_publish
// set with { pubkey, weight, source }) is supplied out of band for the trust-
// minimized path; otherwise it is fetched from the explorer's verify endpoint
// (convenience, weaker: trusts the explorer for the SET, still verifies sigs +
// quorum locally). Returns the verifyCheckpoint result.
async function _verifyQuorum(f, explorerUrl, coin, cp, suppliedValidators){
    let validators = suppliedValidators;
    if (!validators){
        let url = _base(explorerUrl) + '/' + encodeURIComponent(String(coin)) +
                  '/api/checkpoint/' + encodeURIComponent(String(cp.block_index)) + '/verify';
        let vb = await _json(f, url);
        validators = (vb && vb.validators) || [];
    }
    return checkpoint.verifyCheckpoint(cp, validators);
}

// Resolve a served checkpoint `cp` to a quorum verdict. Order of trust:
//   1. caller-supplied `validators` -- an explicit out-of-band set (no fetch).
//   2. the pinned launch set for the coin (spec D4). If it still signs `cp`,
//      done. Otherwise, when the pinned entry also carries a committed-state
//      checkpoint and `cp` is a LATER BTC checkpoint, roll the pinned trust root
//      FORWARD across validator rotation (spec §7.3): followForward proves each
//      successor oracle_publish set against the committed BTC stakes_root (the
//      only chain that commits stakes, §4.1) and adopts it, and we accept iff
//      the walk reaches exactly `cp` (same height + state_root + block-merkle
//      root). The explorer /verify set is NEVER consulted on the pinned path
//      (no silent downgrade); a rotation that cannot be followed fails quorum.
//   3. nothing pinned -> the explorer /verify convenience path (weakest).
// Returns a checkpoint.verifyCheckpoint-shaped { valid, quorum, weighted }.
// Transport failures propagate (throw), exactly like the convenience path.
async function _resolveQuorum(f, opts, cp){
    if (opts.validators) return checkpoint.verifyCheckpoint(cp, opts.validators);
    const entry = _pinnedEntry(opts);
    if (!entry) return _verifyQuorum(f, opts.explorerUrl, opts.coin, cp, null);
    const pinnedVals = (Array.isArray(entry.validators) && entry.validators.length) ? entry.validators : null;
    if (pinnedVals){
        const q = checkpoint.verifyCheckpoint(cp, pinnedVals);
        if (q.valid) return q;                                 // launch epoch: pinned set still signs
    }
    const pcp = entry.checkpoint;
    if (pcp && pcp.state_root != null && _hx(cp.chain) === 'btc'
        && Number(cp.block_index) > Number(pcp.block_index)){
        const ff = await followForward({ explorerUrl: opts.explorerUrl, btcCoin: opts.coin,
            trustedCheckpoint: pcp, toHeight: Number(cp.block_index), fetchImpl: f });
        const t = ff && ff.trusted;
        if (t && Number(t.block_index) === Number(cp.block_index)
            && _hx(t.state_root) === _hx(cp.state_root)
            && _hx(t.block_merkle_root) === _hx(cp.block_merkle_root))
            return { valid: true, quorum: null, weighted: null };
    }
    return { valid: false, quorum: null, weighted: null };
}

// ── Public network API ────────────────────────────────────────────────────────

// verifyBalance({ explorerUrl, coin, address, tick, atHeight?, validators?, trustedCheckpoint?, pinnedResolver?, fetchImpl? })
//  When neither validators nor trustedCheckpoint is given, the pinned launch set
//  for `coin` (spec D4) is used if one is registered, else the explorer's set.
//  A checkpoint past the pinned epoch is verified by rolling the pinned trust
//  root forward across validator rotation (§7.3); see _resolveQuorum.
//  -> { verified, amount, height, reason, checkpoint, quorum, weighted }
// Returns the verified amount as-of the proven (nearest checkpointed >= atHeight)
// height, echoed in `height`. A zero balance verifies as non-inclusion. Throws
// only on transport/shape errors; a failed verification returns verified:false.
async function verifyBalance(opts){
    opts = opts || {};
    const f = _fetch(opts.fetchImpl);
    const hq = (opts.atHeight != null && opts.atHeight !== '') ? ('?height=' + encodeURIComponent(String(opts.atHeight))) : '';
    const url = _base(opts.explorerUrl) + '/' + encodeURIComponent(String(opts.coin)) +
                '/api/proof/balance/' + encodeURIComponent(String(opts.address)) +
                '/' + encodeURIComponent(String(opts.tick)) + hq;
    const body = await _json(f, url);
    if (!body || !body.proof) throw new Error('LightClient: no proof in response');
    const proof = body.proof;
    // Trust source: a caller-supplied pre-trusted checkpoint (e.g. a DOGE-anchored
    // one from verifyAnchoredCheckpoint) binds without re-fetching quorum, but only
    // if the proof is FOR that checkpoint's height; else verify the served one.
    let cp, q;
    if (opts.trustedCheckpoint){
        cp = opts.trustedCheckpoint;
        if (Number(proof.height) !== Number(cp.block_index))
            return { verified: false, amount: null, reason: 'PROOF_HEIGHT_MISMATCH',
                     height: Number(proof.height), checkpoint: cp, quorum: null, weighted: null };
        q = { valid: true, quorum: null, weighted: null };
    } else {
        if (!body.checkpoint) throw new Error('LightClient: no checkpoint in response');
        cp = body.checkpoint;
        q = await _resolveQuorum(f, opts, cp);
    }
    const base = { height: Number(proof.height), checkpoint: cp, quorum: q.quorum, weighted: q.weighted };
    if (!q.valid) return Object.assign({ verified: false, amount: null, reason: 'CHECKPOINT_QUORUM_FAILED' }, base);
    const trusted = _hx(cp.state_root);
    if (!trusted) return Object.assign({ verified: false, amount: null, reason: 'CHECKPOINT_PRE_COMMITMENT' }, base);
    if (_hx(proof.chain) !== _hx(cp.chain) || _hx(proof.network) !== _hx(cp.network))
        return Object.assign({ verified: false, amount: null, reason: 'PROOF_CHECKPOINT_CHAIN_MISMATCH' }, base);
    const v = verifyBalanceProof(proof, trusted, cp.chain, cp.network);
    return Object.assign({ verified: v.verified, amount: v.verified ? v.amount : null, reason: v.reason }, base);
}

// verifyAction({ explorerUrl, coin, actionIndex, validators?, trustedCheckpoint?, pinnedResolver?, fetchImpl? })
//  Same pinned-launch-set (spec D4) fallback as verifyBalance when no validators
//  and no trustedCheckpoint are supplied, including the rotation-aware
//  forward-following of a post-epoch checkpoint (§7.3; see _resolveQuorum).
//  -> { verified, height, action, action_index, tx_index, reason, checkpoint, quorum, weighted }
async function verifyAction(opts){
    opts = opts || {};
    const f = _fetch(opts.fetchImpl);
    const url = _base(opts.explorerUrl) + '/' + encodeURIComponent(String(opts.coin)) +
                '/api/proof/action/' + encodeURIComponent(String(opts.actionIndex));
    const body = await _json(f, url);
    if (!body || !body.proof) throw new Error('LightClient: no proof in response');
    const proof = body.proof;
    let cp, q;
    if (opts.trustedCheckpoint){
        cp = opts.trustedCheckpoint;
        if (Number(proof.height) !== Number(cp.block_index))
            return { verified: false, reason: 'PROOF_HEIGHT_MISMATCH', height: Number(proof.height),
                     action: proof.action, action_index: Number(proof.action_index),
                     tx_index: (proof.tx_index == null) ? null : Number(proof.tx_index),
                     checkpoint: cp, quorum: null, weighted: null };
        q = { valid: true, quorum: null, weighted: null };
    } else {
        if (!body.checkpoint) throw new Error('LightClient: no checkpoint in response');
        cp = body.checkpoint;
        q = await _resolveQuorum(f, opts, cp);
    }
    const base = { height: Number(proof.height), action: proof.action, action_index: Number(proof.action_index),
                   tx_index: (proof.tx_index == null) ? null : Number(proof.tx_index),
                   checkpoint: cp, quorum: q.quorum, weighted: q.weighted };
    if (!q.valid) return Object.assign({ verified: false, reason: 'CHECKPOINT_QUORUM_FAILED' }, base);
    const trusted = _hx(cp.block_merkle_root);
    if (!trusted) return Object.assign({ verified: false, reason: 'CHECKPOINT_PRE_COMMITMENT' }, base);
    if (Number(proof.action_index) !== Number(opts.actionIndex))
        return Object.assign({ verified: false, reason: 'ACTION_INDEX_MISMATCH' }, base);
    const v = verifyActionProof(proof, trusted);
    return Object.assign({ verified: v.verified, reason: v.reason }, base);
}

// ── DOGE-anchor cold-start trust (spec §7.2 b / D4) ───────────────────────────
// A client with no prior trust root bootstraps from the on-chain ANCHOR: read the
// latest root-bearing ANCHOR (v3, or v5 at/above the ANCHOR_REWARD flag-day) off DOGE,
// confirm it is buried under a chosen PoW depth, and
// adopt its quorum-signed checkpoint. Trust still bottoms out at the federation
// quorum (the DOGE PoW only hardens delivery/timing, §7.4); the SDK has no DOGE
// backend, so the caller supplies the confirmation depth from its own DOGE source.

// Parse a root-bearing ANCHOR wire string (optional leading "ANCHOR|") into the
// checkpoint shape sdk.checkpoint.verifyCheckpoint consumes. Accepts v3 AND v5
// (v5 = the v3 checkpoint + an elected-publisher reward attestation tail): both
// carry the SPV roots at the same positions and the same SIG_COUNT index, so the
// v5 publisher/attestation tail simply trails the signature list and is ignored
// here (SPV trust bottoms out at the checkpoint quorum, not the reward attestation).
// A rootless v0/v4 anchor is rejected. Pure; for callers who decode the raw DOGE
// transaction themselves. Throws on a malformed / non-root-bearing string.
function parseAnchorV3(wire){
    let p = String(wire || '').split('|');
    if (p.length && /^anchor$/i.test(p[0])) p = p.slice(1);
    const ver = String(p[0]);
    if (ver !== '3' && ver !== '5') throw new Error('LightClient: not a root-bearing ANCHOR (need v3 or v5, got VERSION ' + p[0] + ')');
    const sigBase = 14;                                        // formats[3]/[5] index of SIG_COUNT (roots occupy p[10..13])
    const n = parseInt(p[sigBase], 10);
    if (!Number.isFinite(n) || n < 1) throw new Error('LightClient: bad ANCHOR SIG_COUNT');
    const sigs = [];
    for (let i = 0; i < n; i++){
        const pubkey = p[sigBase + 1 + 2 * i], sig = p[sigBase + 1 + 2 * i + 1];
        if (!pubkey || !sig) throw new Error('LightClient: missing ANCHOR sig at index ' + i);
        sigs.push({ pubkey: String(pubkey).toLowerCase(), sig: String(sig).toLowerCase() });
    }
    return {
        chain: String(p[1] || '').toUpperCase(), network: String(p[2] || ''),
        block_index: Number(p[3]), block_hash: _hx(p[4]),
        ledger_hash: _hx(p[5]), actions_hash: _hx(p[6]), contract_hash: _hx(p[7]),
        checkpoint_seq: Number(p[8]), snapshot_block: Number(p[9]),
        state_root: _hx(p[10]), state_root_version: Number(p[11]),
        block_merkle_root: _hx(p[12]), block_merkle_version: Number(p[13]),
        validator_signatures: sigs
    };
}

// Normalize an explorer /api/anchors record (a full row) into the checkpoint shape.
function anchorToCheckpoint(a){
    if (!a) throw new Error('LightClient: empty anchor record');
    let sigs = a.validator_signatures;
    if (typeof sigs === 'string'){ try { sigs = JSON.parse(sigs); } catch (e){ sigs = []; } }
    if (!Array.isArray(sigs)) sigs = [];
    return {
        chain: a.chain, network: a.network, block_index: Number(a.block_index),
        block_hash: a.block_hash, ledger_hash: a.ledger_hash, actions_hash: a.actions_hash, contract_hash: a.contract_hash,
        checkpoint_seq: Number(a.checkpoint_seq), snapshot_block: Number(a.snapshot_block),
        state_root: a.state_root, state_root_version: a.state_root_version,
        block_merkle_root: a.block_merkle_root, block_merkle_version: a.block_merkle_version,
        validator_signatures: sigs
    };
}

// Verify a DOGE-anchored checkpoint as a trust root. `checkpoint` is the normalized
// object (parseAnchorV3 / anchorToCheckpoint), which MUST carry the v3 roots;
// `confirmations` is the DOGE depth the caller obtained from its own DOGE source.
// Returns { verified, reason, checkpoint, confirmations, minDepth, quorum, weighted }.
function verifyAnchoredCheckpoint(opts){
    opts = opts || {};
    const cp = opts.checkpoint;
    const minDepth = (opts.minDepth != null) ? Number(opts.minDepth) : DEFAULT_ANCHOR_MIN_DEPTH;
    const confirmations = Number(opts.confirmations);
    const safeConf = Number.isFinite(confirmations) ? confirmations : 0;
    if (!cp) return { verified: false, reason: 'NO_CHECKPOINT', checkpoint: null, confirmations: 0, minDepth, quorum: null, weighted: null };
    // v3/v5 carry the committed roots; a rootless (v0/v4) anchor cannot serve SPV trust.
    if (cp.state_root == null || cp.block_merkle_root == null)
        return { verified: false, reason: 'NOT_A_V3_ANCHOR', checkpoint: cp, confirmations: safeConf, minDepth, quorum: null, weighted: null };
    const q = checkpoint.verifyCheckpoint(cp, opts.validators || []);
    const base = { checkpoint: cp, confirmations: safeConf, minDepth, quorum: q.quorum, weighted: q.weighted };
    if (!q.valid) return Object.assign({ verified: false, reason: 'CHECKPOINT_QUORUM_FAILED' }, base);
    if (!(Number.isFinite(confirmations) && confirmations >= minDepth))
        return Object.assign({ verified: false, reason: 'INSUFFICIENT_DOGE_DEPTH' }, base);
    return Object.assign({ verified: true, reason: null }, base);
}

// Convenience: fetch the latest root-bearing ANCHOR (v3 or v5) for `targetChain` from the DOGE explorer,
// confirm its DOGE depth (caller supplies the tip via dogeTipHeight or getDogeTipHeight),
// and verify it. Anchors are DOGE-only, so the list is served by the DOGE explorer;
// each record's `chain` is the chain whose checkpoint it commits. Returns the
// verifyAnchoredCheckpoint result plus { anchor, dogeTxid }.
async function fetchAnchoredCheckpoint(opts){
    opts = opts || {};
    const f = _fetch(opts.fetchImpl);
    const dogeCoin = opts.dogeCoin || 'DOGE';
    const minDepth = (opts.minDepth != null) ? Number(opts.minDepth) : DEFAULT_ANCHOR_MIN_DEPTH;
    const url = _base(opts.explorerUrl) + '/' + encodeURIComponent(String(dogeCoin)) +
                '/api/anchors/' + encodeURIComponent(String(opts.targetChain)) + '/chain';
    const body = await _json(f, url);
    let rows = Array.isArray(body) ? body : ((body && (body.data || body.results || body.rows)) || []);
    // Accept v3 and v5: both carry the SPV roots (v5 = v3 + a publisher reward attestation,
    // emitted in place of v3 at/above the ANCHOR_REWARD flag-day). v0/v4 are rootless and
    // filtered out by the state_root presence check.
    rows = rows.filter(r => r && (Number(r.version) === 3 || Number(r.version) === 5) && r.state_root &&
                            String(r.chain).toUpperCase() === String(opts.targetChain).toUpperCase());
    rows.sort((a, b) => Number(b.checkpoint_seq) - Number(a.checkpoint_seq));   // newest checkpoint first
    if (!rows.length)
        return { verified: false, reason: 'NO_ROOT_ANCHOR', checkpoint: null, anchor: null, dogeTxid: null, confirmations: 0, minDepth, quorum: null, weighted: null };
    const rec = rows[0];
    let tip = opts.dogeTipHeight;
    if (tip == null && typeof opts.getDogeTipHeight === 'function') tip = await opts.getDogeTipHeight();
    const confirmations = (tip != null && rec.block_index_doge != null)
        ? (Number(tip) - Number(rec.block_index_doge) + 1) : NaN;
    const res = verifyAnchoredCheckpoint({ checkpoint: anchorToCheckpoint(rec), validators: opts.validators,
        confirmations, minDepth });
    return Object.assign({}, res, { anchor: rec, dogeTxid: rec.tx_hash || null });
}

// ── Validator-set proof + forward-following (spec §7, Phase 5) ────────────────
// The keystone of a self-verifying client: instead of trusting an explorer for the
// signer set, the client PROVES each signer's (source, weight) and the source-deduped
// total S against a trusted, committed BTC `stakes_root`, then checks the weighted
// quorum `3·Σ(distinct signer-source weight) > 2·S` locally. Breaks the §7.1 circularity.

function _scaled(a){ const [i, f] = M.canonicalAmount(String(a)).split('.'); return BigInt(i) * 1000000000000000000n + BigInt(f); }

// Pure: verify a /proof/validator-set response binds into a TRUSTED state_root.
// Returns { verified, capabilities: { cap: { validators:[{pubkey,source,weight}], total } }, reason }.
// Every returned (pubkey, source, weight) is membership-proven; `total` is the
// committed source-deduped S (proven via the __total__ leaf).
function verifyValidatorSetProof(proof, trustedStateRoot){
    try {
        if (!proof || !proof.sub_root_path || !proof.capabilities) return { verified: false, capabilities: {}, reason: 'MALFORMED_PROOF' };
        // 1. stakes_root binds into the trusted state_root (fixed 5-leaf top tree).
        if (!M.verifyFixedMerkleProof(trustedStateRoot, M.toBuf(proof.stakes_root), proof.sub_root_path.index, proof.sub_root_path.siblings))
            return { verified: false, capabilities: {}, reason: 'SUBROOT_BIND_INVALID' };
        const out = {};
        for (const cap of Object.keys(proof.capabilities)){
            const c = proof.capabilities[cap];
            const validators = [];
            for (const v of (c.validators || [])){
                // The committed leaf must be exactly stakeMemberLeaf(source, weight) and
                // the SMT proof must reconstruct stakes_root for stakeKey(pubkey, cap).
                if (_hx(v.smt_proof && v.smt_proof.leaf_value) !== M.toHex(M.stakeMemberLeaf(v.source, v.weight)))
                    return { verified: false, capabilities: {}, reason: 'MEMBER_LEAF_MISMATCH:' + v.pubkey };
                if (!M.verifyCompressedSmtProof(proof.stakes_root, M.stakeKey(String(v.pubkey), cap), v.smt_proof.leaf_value, v.smt_proof.compressed))
                    return { verified: false, capabilities: {}, reason: 'MEMBER_PROOF_INVALID:' + v.pubkey };
                validators.push({ pubkey: String(v.pubkey), source: String(v.source), weight: String(v.weight) });
            }
            // The committed total S (proven via __total__) is the quorum denominator.
            let total = '0';
            if (c.total_proof){
                if (_hx(c.total_proof.leaf_value) !== M.toHex(M.stakeTotalLeaf(c.total)))
                    return { verified: false, capabilities: {}, reason: 'TOTAL_LEAF_MISMATCH:' + cap };
                if (!M.verifyCompressedSmtProof(proof.stakes_root, M.stakeKey(M.STAKE_TOTAL_PUBKEY, cap), c.total_proof.leaf_value, c.total_proof.compressed))
                    return { verified: false, capabilities: {}, reason: 'TOTAL_PROOF_INVALID:' + cap };
                total = M.canonicalAmount(String(c.total));
            }
            out[cap] = { validators, total };
        }
        return { verified: true, capabilities: out, reason: null };
    } catch (e){ return { verified: false, capabilities: {}, reason: 'VERIFY_ERROR:' + (e && e.message) }; }
}

// Network: fetch + verify the validator-set proof at BTC snapshot height S.
async function verifyValidatorSet(opts){
    opts = opts || {};
    const f = _fetch(opts.fetchImpl);
    const url = _base(opts.explorerUrl) + '/' + encodeURIComponent(String(opts.btcCoin || 'BTC')) +
                '/api/proof/validator-set?height=' + encodeURIComponent(String(opts.snapshotBlock));
    const body = await _json(f, url);
    if (!body || !body.proof) throw new Error('LightClient: no validator-set proof in response');
    const v = verifyValidatorSetProof(body.proof, opts.trustedStateRoot);
    return Object.assign({}, v, { height: Number(body.proof.height), checkpoint: body.checkpoint });
}

// Pure: verify a checkpoint's quorum using a PROVEN validator set (from
// verifyValidatorSet). Source-dedupes valid signers and checks 3·Σ > 2·S against the
// committed total. Fully trustless: nothing here trusts a server-supplied set.
function verifyCheckpointWithProvenSet(cp, provenOraclePublish){
    const canonical = cp && checkpoint.canonicalCheckpoint(cp);
    const bySource = new Map(), pkToSource = new Map();
    for (const v of ((provenOraclePublish && provenOraclePublish.validators) || [])){
        const s = String(v.source), pk = String(v.pubkey).toLowerCase();
        pkToSource.set(pk, s);
        if (!bySource.has(s)) bySource.set(s, String(v.weight));
    }
    let sigs = cp && cp.validator_signatures;
    if (typeof sigs === 'string'){ try { sigs = JSON.parse(sigs); } catch (e){ sigs = []; } }
    if (!Array.isArray(sigs)) sigs = [];
    const countedSources = new Set(), seenPk = new Set(), weights = [];
    for (const sig of sigs){
        const pk = String(sig && sig.pubkey || '').toLowerCase();
        if (seenPk.has(pk)) continue; seenPk.add(pk);
        const src = pkToSource.get(pk);
        if (src === undefined) continue;                          // signer not in the proven set
        if (!checkpoint.verifySignature(canonical, String(sig && sig.sig || ''), pk)) continue;
        if (countedSources.has(src)) continue; countedSources.add(src);   // source-dedupe
        weights.push(bySource.get(src));
    }
    const numerator = M.sumCanonicalAmounts(weights);
    const total = M.canonicalAmount(String((provenOraclePublish && provenOraclePublish.total) || '0'));
    const valid = _scaled(total) > 0n && 3n * _scaled(numerator) > 2n * _scaled(total);
    return { valid, numerator, total };
}

// Forward-following (spec §7.3): from a trusted BTC checkpoint, walk /checkpoints/range
// and adopt each next checkpoint whose quorum verifies against a validator set proven at
// its snapshot_block (against the current trusted BTC state_root). Returns the new rolling
// trust root + the chain of adopted checkpoints. Stops at the first step that fails to verify.
async function followForward(opts){
    opts = opts || {};
    const f = _fetch(opts.fetchImpl);
    const btcCoin = opts.btcCoin || 'BTC';
    let trusted = opts.trustedCheckpoint;
    if (!trusted || trusted.state_root == null) throw new Error('LightClient: followForward needs a trusted BTC checkpoint with a committed state_root');
    const from = Number(trusted.block_index) + 1;
    const to   = Number(opts.toHeight != null ? opts.toHeight : trusted.block_index);
    const adopted = [];
    if (to >= from){
        const rangeUrl = _base(opts.explorerUrl) + '/' + encodeURIComponent(String(btcCoin)) +
                         '/api/checkpoints/range?from=' + from + '&to=' + to;
        const rangeBody = await _json(f, rangeUrl);
        const steps = (rangeBody && rangeBody.checkpoints) || [];
        for (const next of steps){
            // Prove the signer set at next.snapshot_block against the current trusted state_root.
            const vs = await verifyValidatorSet({ explorerUrl: opts.explorerUrl, btcCoin,
                snapshotBlock: next.snapshot_block, trustedStateRoot: _hx(trusted.state_root), fetchImpl: f });
            if (!vs.verified) return { trusted, adopted, reason: 'VALIDATOR_SET_UNVERIFIED@' + next.block_index, stoppedAt: next.block_index };
            const q = verifyCheckpointWithProvenSet(next, vs.capabilities.oracle_publish);
            if (!q.valid) return { trusted, adopted, reason: 'QUORUM_FAILED@' + next.block_index, stoppedAt: next.block_index };
            trusted = next; adopted.push(next);                   // roll the trust root forward
        }
    }
    return { trusted, adopted, reason: null, stoppedAt: null };
}

module.exports = {
    verifyBalanceProof,
    verifyActionProof,
    verifyBalance,
    verifyAction,
    parseAnchorV3,
    anchorToCheckpoint,
    verifyAnchoredCheckpoint,
    fetchAnchoredCheckpoint,
    verifyValidatorSetProof,
    verifyValidatorSet,
    verifyCheckpointWithProvenSet,
    followForward
};
