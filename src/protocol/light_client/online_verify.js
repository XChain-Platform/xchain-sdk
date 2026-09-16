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
 * SPV light client: verifies balances, actions, and validator sets against
 * quorum-signed checkpoints (spec §4.4, §5, §7, §8).
 *
 ********************************************************************/

'use strict';

const M = require('../../merkle.js');
// Identity of a wire index is decided as BigInt, never Number(): the explorer
// serializes BIGINT columns as decimal strings, and Number() collapses two
// adjacent indices above 2^53 onto one value, so the binding guards below would
// match the neighbouring action or height they exist to reject.
const { sameWireIndex } = require('../../utils/wire_index.js');
const { _fetch, baseUrl, _json, _hx } = require('./fetch_helpers.js');
const { verifyBalanceProof, verifyLockedBalanceProof, verifyActionProof } = require('./proof_checks.js');
const { resolveQuorum } = require('./quorum_resolution.js');

// ── Public network API ────────────────────────────────────────────────────────

// verifyBalance({ explorerUrl, coin, address, tick, atHeight?, validators?, trustedCheckpoint?, pinnedResolver?, fetchImpl? })
//  When neither validators nor trustedCheckpoint is given, the pinned launch set
//  for `coin` (spec D4) is used if one is registered, else the explorer's set.
//  A checkpoint past the pinned epoch is verified by rolling the pinned trust
//  root forward across validator rotation (§7.3); see resolveQuorum.
//  -> { verified, amount, height, reason, checkpoint, quorum, weighted }
// Returns the verified amount as-of the proven (nearest checkpointed >= atHeight)
// height, echoed in `height`. A zero balance verifies as non-inclusion. Throws
// only on transport/shape errors; a failed verification returns verified:false.
async function verifyBalance(opts){
    opts = opts || {};
    const f = _fetch(opts.fetchImpl);
    const hq = (opts.atHeight != null && opts.atHeight !== '') ? ('?height=' + encodeURIComponent(String(opts.atHeight))) : '';
    const url = baseUrl(opts.explorerUrl) + '/' + encodeURIComponent(String(opts.coin)) +
                '/api/proof/balance/' + encodeURIComponent(String(opts.address)) +
                '/' + encodeURIComponent(String(opts.tick)) + hq;
    const body = await _json(f, url);
    if (!body || !body.proof) throw new Error('LightClient: no proof in response');
    const proof = body.proof;
    const resolved = await resolveBalanceCheckpoint(f, opts, body, proof);
    if (resolved.error) return resolved.error;
    const { cp, q } = resolved;
    // Report the checkpoint's height, never the response's `height` label: the label
    // is not hashed into the proof, so it is a server claim, while cp.block_index is
    // covered by the quorum signature. The binding check below makes the two equal on
    // every success path; sourcing from cp keeps the metadata honest if it regresses.
    const base = { height: Number(cp.block_index), checkpoint: cp, quorum: q.quorum, weighted: q.weighted };
    if (!q.valid) return Object.assign({ verified: false, amount: null, reason: 'CHECKPOINT_QUORUM_FAILED' }, base);
    // Bind the served proof to the served checkpoint. proofServer emits height as
    // Number(cp.block_index) for the SAME cp it returns, so a divergence is a drifted
    // or hostile explorer relabelling a genuine old proof with a fresher height. The
    // trustedCheckpoint branch has always enforced this; the server-served branch did
    // not, which let stale state pass as current.
    if (!sameWireIndex(proof.height, cp.block_index))
        return Object.assign({ verified: false, amount: null, reason: 'PROOF_HEIGHT_MISMATCH' }, base);
    // Enforce the request's lower bound. /proof/balance?height=H is defined as the
    // nearest checkpoint AT OR ABOVE H, so a checkpoint below H answers a different
    // question than the caller asked and must not verify.
    if (opts.atHeight != null && opts.atHeight !== '' && Number(cp.block_index) < Number(opts.atHeight))
        return Object.assign({ verified: false, amount: null, reason: 'CHECKPOINT_BELOW_ATHEIGHT' }, base);
    const trusted = _hx(cp.state_root);
    if (!trusted) return Object.assign({ verified: false, amount: null, reason: 'CHECKPOINT_PRE_COMMITMENT' }, base);
    if (_hx(proof.chain) !== _hx(cp.chain) || _hx(proof.network) !== _hx(cp.network))
        return Object.assign({ verified: false, amount: null, reason: 'PROOF_CHECKPOINT_CHAIN_MISMATCH' }, base);
    // Bind the proof to the ACTUAL query. verifyBalanceProof only checks the proven
    // key against balanceKey(chain, network, proof.address, proof.tick) -- the
    // SERVER-echoed fields -- so on its own it proves internal consistency, not that
    // the proof answers what was asked. Derive the expected key from the CALLER's
    // opts.address/opts.tick (balanceKey does no normalization) and require the proof
    // to prove exactly that key; otherwise a server could answer a query about
    // address A with a genuinely-committed proof for a different address B and its
    // real balance. (verifyAction guards the analogous case via ACTION_INDEX_MISMATCH.)
    const expectedKey = M.toHex(M.balanceKey(cp.chain, cp.network, String(opts.address), String(opts.tick)));
    if (!proof.smt_proof || _hx(proof.smt_proof.key) !== expectedKey)
        return Object.assign({ verified: false, amount: null, reason: 'BALANCE_QUERY_MISMATCH' }, base);
    // Bind inside the verifier too: the expectedKey check above guards the proven
    // key, `expected` guards the echoed address/tick fields the caller will read.
    const v = verifyBalanceProof(proof, trusted, cp.chain, cp.network,
                                 { address: String(opts.address), tick: String(opts.tick) });
    return Object.assign({ verified: v.verified, amount: v.verified ? v.amount : null, reason: v.reason }, base);
}

async function resolveBalanceCheckpoint(f, opts, body, proof){
    // Trust source: a caller-supplied pre-trusted checkpoint (e.g. a DOGE-anchored
    // one from verifyAnchoredCheckpoint) binds without re-fetching quorum, but only
    // if the proof is FOR that checkpoint's height; else verify the served one.
    let cp, q;
    if (opts.trustedCheckpoint){
        cp = opts.trustedCheckpoint;
        if (!sameWireIndex(proof.height, cp.block_index))
            return { error: { verified: false, amount: null, reason: 'PROOF_HEIGHT_MISMATCH',
                              height: Number(proof.height), checkpoint: cp, quorum: null, weighted: null } };
        q = { valid: true, quorum: null, weighted: null };
    } else {
        if (!body.checkpoint) throw new Error('LightClient: no checkpoint in response');
        cp = body.checkpoint;
        q = await resolveQuorum(f, opts, cp);
    }
    return { cp, q };
}

// verifyLockedBalance({ explorerUrl, coin, address, tick, atHeight?, validators?, trustedCheckpoint?, pinnedResolver?, fetchImpl? })
//  The XCHAIN_ESC counterpart of verifyBalance, same options and same
//  -> { verified, amount, height, reason, checkpoint, quorum, weighted }.
//
// This wrapper is the reason the locked verifier can enforce liveness at all: it
// is the only in-SDK place that HOLDS the quorum-signed checkpoint, so it is the
// only place that can hand the verifier a trusted height. Without it every caller
// had to bind proof.height to their checkpoint by hand, and the pure verifier was
// left gating arming on the server's own label.
//
// A below-arming request is refused by the explorer with an error body rather than
// a proof (proofServer.lockedBalanceProof). That refusal is a real answer here, not
// a transport fault, so it is returned as verified:false with the server's reason
// instead of throwing the way an absent proof does on the spendable path.
async function verifyLockedBalance(opts){
    opts = opts || {};
    const f = _fetch(opts.fetchImpl);
    const hq = (opts.atHeight != null && opts.atHeight !== '') ? ('?height=' + encodeURIComponent(String(opts.atHeight))) : '';
    const url = baseUrl(opts.explorerUrl) + '/' + encodeURIComponent(String(opts.coin)) +
                '/api/proof/locked-balance/' + encodeURIComponent(String(opts.address)) +
                '/' + encodeURIComponent(String(opts.tick)) + hq;
    const body = await _json(f, url);
    if (body && !body.proof && typeof body.error === 'string' && body.error)
        return { verified: false, amount: null, reason: body.error,
                 height: null, checkpoint: null, quorum: null, weighted: null };
    if (!body || !body.proof) throw new Error('LightClient: no proof in response');
    const proof = body.proof;
    let cp, q;
    if (opts.trustedCheckpoint){
        cp = opts.trustedCheckpoint;
        if (!sameWireIndex(proof.height, cp.block_index))
            return { verified: false, amount: null, reason: 'PROOF_HEIGHT_MISMATCH',
                     height: Number(proof.height), checkpoint: cp, quorum: null, weighted: null };
        q = { valid: true, quorum: null, weighted: null };
    } else {
        if (!body.checkpoint) throw new Error('LightClient: no checkpoint in response');
        cp = body.checkpoint;
        q = await resolveQuorum(f, opts, cp);
    }
    // Height reported from the quorum-signed checkpoint, never the response label,
    // for the reason verifyBalance gives.
    const base = { height: Number(cp.block_index), checkpoint: cp, quorum: q.quorum, weighted: q.weighted };
    if (!q.valid) return Object.assign({ verified: false, amount: null, reason: 'CHECKPOINT_QUORUM_FAILED' }, base);
    if (!sameWireIndex(proof.height, cp.block_index))
        return Object.assign({ verified: false, amount: null, reason: 'PROOF_HEIGHT_MISMATCH' }, base);
    if (opts.atHeight != null && opts.atHeight !== '' && Number(cp.block_index) < Number(opts.atHeight))
        return Object.assign({ verified: false, amount: null, reason: 'CHECKPOINT_BELOW_ATHEIGHT' }, base);
    const trusted = _hx(cp.state_root);
    if (!trusted) return Object.assign({ verified: false, amount: null, reason: 'CHECKPOINT_PRE_COMMITMENT' }, base);
    if (_hx(proof.chain) !== _hx(cp.chain) || _hx(proof.network) !== _hx(cp.network))
        return Object.assign({ verified: false, amount: null, reason: 'PROOF_CHECKPOINT_CHAIN_MISMATCH' }, base);
    // Bind the proven key to the CALLER's query in the ESC domain, the escrow
    // counterpart of BALANCE_QUERY_MISMATCH.
    const expectedKey = M.toHex(M.escrowKey(cp.chain, cp.network, String(opts.address), String(opts.tick)));
    if (!proof.smt_proof || _hx(proof.smt_proof.key) !== expectedKey)
        return Object.assign({ verified: false, amount: null, reason: 'LOCKED_QUERY_MISMATCH' }, base);
    const v = verifyLockedBalanceProof(proof, trusted, cp.chain, cp.network,
                                       { address: String(opts.address), tick: String(opts.tick) },
                                       cp.block_index);
    return Object.assign({ verified: v.verified, amount: v.verified ? v.amount : null, reason: v.reason }, base);
}

// verifyAction({ explorerUrl, coin, actionIndex, validators?, trustedCheckpoint?, pinnedResolver?, fetchImpl? })
//  Same pinned-launch-set (spec D4) fallback as verifyBalance when no validators
//  and no trustedCheckpoint are supplied, including the rotation-aware
//  forward-following of a post-epoch checkpoint (§7.3; see resolveQuorum).
//  -> { verified, height, action, action_index, tx_index, reason, checkpoint, quorum, weighted }
async function verifyAction(opts){
    opts = opts || {};
    const f = _fetch(opts.fetchImpl);
    const url = baseUrl(opts.explorerUrl) + '/' + encodeURIComponent(String(opts.coin)) +
                '/api/proof/action/' + encodeURIComponent(String(opts.actionIndex));
    const body = await _json(f, url);
    if (!body || !body.proof) throw new Error('LightClient: no proof in response');
    const proof = body.proof;
    let cp, q;
    if (opts.trustedCheckpoint){
        cp = opts.trustedCheckpoint;
        if (!sameWireIndex(proof.height, cp.block_index))
            return { verified: false, reason: 'PROOF_HEIGHT_MISMATCH', height: Number(proof.height),
                     action: proof.action, action_index: Number(proof.action_index),
                     tx_index: (proof.tx_index == null) ? null : Number(proof.tx_index),
                     checkpoint: cp, quorum: null, weighted: null };
        q = { valid: true, quorum: null, weighted: null };
    } else {
        if (!body.checkpoint) throw new Error('LightClient: no checkpoint in response');
        cp = body.checkpoint;
        q = await resolveQuorum(f, opts, cp);
    }
    // Height comes from the quorum-signed checkpoint, not the response label (see verifyBalance).
    const base = { height: Number(cp.block_index), action: proof.action, action_index: Number(proof.action_index),
                   tx_index: (proof.tx_index == null) ? null : Number(proof.tx_index),
                   checkpoint: cp, quorum: q.quorum, weighted: q.weighted };
    if (!q.valid) return Object.assign({ verified: false, reason: 'CHECKPOINT_QUORUM_FAILED' }, base);
    // Bind the served proof to the served checkpoint in the server-served branch too;
    // actionProof emits height as Number(cp.block_index) for that same cp.
    if (!sameWireIndex(proof.height, cp.block_index))
        return Object.assign({ verified: false, reason: 'PROOF_HEIGHT_MISMATCH' }, base);
    const trusted = _hx(cp.block_merkle_root);
    if (!trusted) return Object.assign({ verified: false, reason: 'CHECKPOINT_PRE_COMMITMENT' }, base);
    // The ONLY check binding this proof to the action the caller asked about, and
    // verifyActionProof cannot back it up: that verifier recomputes the leaf FROM
    // proof.action_index, so a genuine proof for the neighbouring action recomputes
    // and merkle-verifies cleanly. Compared exactly (see sameWireIndex).
    if (!sameWireIndex(proof.action_index, opts.actionIndex))
        return Object.assign({ verified: false, reason: 'ACTION_INDEX_MISMATCH' }, base);
    const v = verifyActionProof(proof, trusted);
    return Object.assign({ verified: v.verified, reason: v.reason }, base);
}

module.exports = { verifyBalance, verifyLockedBalance, verifyAction };
