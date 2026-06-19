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

function _fetch(impl){
    let f = impl || (typeof fetch === 'function' ? fetch : null);
    if (!f) throw new Error('LightClient: no fetch implementation available');
    return f;
}
function _base(u){ return String(u || '').replace(/\/+$/, ''); }
async function _json(f, url){
    let r = await f(url);
    if (!r.ok) throw new Error('LightClient: explorer returned HTTP ' + r.status);
    return r.json();
}
function _hx(x){ return String(x == null ? '' : x).toLowerCase(); }

// ── Pure verifiers (no network; the heart of the light client) ────────────────

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

// ── Public network API ────────────────────────────────────────────────────────

// verifyBalance({ explorerUrl, coin, address, tick, atHeight?, validators?, fetchImpl? })
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
    if (!body || !body.proof || !body.checkpoint) throw new Error('LightClient: no proof/checkpoint in response');
    const proof = body.proof, cp = body.checkpoint;
    const q = await _verifyQuorum(f, opts.explorerUrl, opts.coin, cp, opts.validators);
    const base = { height: Number(proof.height), checkpoint: cp, quorum: q.quorum, weighted: q.weighted };
    if (!q.valid) return Object.assign({ verified: false, amount: null, reason: 'CHECKPOINT_QUORUM_FAILED' }, base);
    const trusted = _hx(cp.state_root);
    if (!trusted) return Object.assign({ verified: false, amount: null, reason: 'CHECKPOINT_PRE_COMMITMENT' }, base);
    if (_hx(proof.chain) !== _hx(cp.chain) || _hx(proof.network) !== _hx(cp.network))
        return Object.assign({ verified: false, amount: null, reason: 'PROOF_CHECKPOINT_CHAIN_MISMATCH' }, base);
    const v = verifyBalanceProof(proof, trusted, cp.chain, cp.network);
    return Object.assign({ verified: v.verified, amount: v.verified ? v.amount : null, reason: v.reason }, base);
}

// verifyAction({ explorerUrl, coin, actionIndex, validators?, fetchImpl? })
//  -> { verified, height, action, action_index, tx_index, reason, checkpoint, quorum, weighted }
async function verifyAction(opts){
    opts = opts || {};
    const f = _fetch(opts.fetchImpl);
    const url = _base(opts.explorerUrl) + '/' + encodeURIComponent(String(opts.coin)) +
                '/api/proof/action/' + encodeURIComponent(String(opts.actionIndex));
    const body = await _json(f, url);
    if (!body || !body.proof || !body.checkpoint) throw new Error('LightClient: no proof/checkpoint in response');
    const proof = body.proof, cp = body.checkpoint;
    const q = await _verifyQuorum(f, opts.explorerUrl, opts.coin, cp, opts.validators);
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

module.exports = {
    verifyBalanceProof,
    verifyActionProof,
    verifyBalance,
    verifyAction
};
