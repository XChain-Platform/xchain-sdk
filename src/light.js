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

const M          = require('./merkle.js');
const SUB        = require('./state_subtree_activation.js');
const checkpoint = require('./checkpoint.js');
const ckptCommit = require('./checkpoint_commitment_activation.js');
const pinned     = require('./pinnedCheckpoints.js');
const swq        = require('./stake_weighted_quorum.js');
const srb        = require('./snapshot_reorg_buffer.js');

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
// Trailing slashes trimmed by loop rather than /\/+$/: the quantified group
// backtracks polynomially on a long run of slashes in a caller-supplied URL.
function _base(u){ let s = String(u || ''); while (s.endsWith('/')) s = s.slice(0, -1); return s; }
async function _json(f, url){
    let r = await f(url);
    if (!r.ok) throw new Error('LightClient: explorer returned HTTP ' + r.status);
    return r.json();
}
function _hx(x){ return String(x == null ? '' : x).toLowerCase(); }

// Bind a proof to the question the CALLER asked, not merely to the one the server
// echoed. Every verifier below re-derives its SMT key from fields carried IN the
// proof (`address`/`tick`, `contract_index`/`state_key`), which proves the proof is
// internally consistent and says nothing about whether it answers your request. A
// server that returns a valid proof for a DIFFERENT key therefore verifies clean.
//
// That is not hypothetical: the explorer's contract-state route decoded its path
// param a second time after Express had already decoded it, so a request for the
// key `a%41b` was answered, validly and verifiably, for the key `aAb` (measured on
// the live service 2026-08-06). The corruption was upstream, but
// nothing downstream could see it.
//
// `expected` is OPTIONAL so this stays backward compatible; callers that pass it
// get the binding. Only the fields present are compared, each as a string, so a
// numeric contract_index and its decimal spelling agree.
function _expectedMismatch(expected, actual){
    if (!expected) return null;
    for (const field of Object.keys(expected)){
        const want = expected[field];
        if (want === undefined || want === null) continue;
        if (String(want) !== String(actual[field])) return field;
    }
    return null;
}

// Default DOGE confirmation depth a cold-start anchor must be buried under before
// it is trusted. DOGE blocks ~1 min and ANCHORs land ~daily, so a recent valid
// anchor is normally far deeper than this; callers SHOULD set their own policy.
const DEFAULT_ANCHOR_MIN_DEPTH = 60;

// Verify a §4.4 BalanceProof binds to a TRUSTED state_root (one already proven to
// be in a quorum-signed checkpoint). chain/network come from the trusted
// checkpoint, never the proof. Returns { verified, amount, reason }.
function verifyBalanceProof(proof, trustedStateRoot, chain, network, expected){
    try {
        if (!proof || !proof.smt_proof || !proof.sub_root_path) return _no('MALFORMED_PROOF');
        // Bind to the REQUESTED (address, tick) when the caller supplies it; the
        // check below only proves the proof is self-consistent. See _expectedMismatch.
        if (_expectedMismatch(expected, proof)) return _no('REQUESTED_IDENTITY_MISMATCH');
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
        //
        // PIN the slot: the authoring side always builds the path for the
        // balances_root slot (index 0). Without this check a server could bind
        // against an EMPTY slot (2..4 are the constant EMPTY_SMT_ROOT in
        // state_root_version 1), present leaf_value:null + amount:"0", and prove
        // a false ZERO balance for an address that actually holds funds -- a
        // solvency/censorship-denial primitive, not just liveness.
        if (proof.sub_root_path.index !== M.STATE_SUBTREES.indexOf('balances_root'))
            return _no('SUBROOT_SLOT_MISMATCH');
        if (!M.verifyFixedMerkleProof(trustedStateRoot, M.toBuf(proof.balances_root),
                                      proof.sub_root_path.index, proof.sub_root_path.siblings))
            return _no('SUBROOT_BIND_INVALID');
        return { verified: true, amount, reason: null };
    } catch (e){ return _no('VERIFY_ERROR:' + (e && e.message)); }
}

// Verify a locked-balance (XCHAIN_ESC) proof binds to a TRUSTED state_root (SPV
// sub-tree spec §3 Stage B). Returns { verified, amount, reason }.
//
// The locked leaf lives INSIDE balances_root, a second key domain beside the
// spendable leaf, so this is verifyBalanceProof with the escrowKey derivation
// and the same balances_root slot pin. The two domains cannot answer for each
// other: each verifier derives its own key, so a spendable proof fed here (or
// the reverse) fails KEY_MISMATCH.
//
// LIVENESS IS ENFORCED HERE, NOT TRUSTED FROM THE SERVER, and this is the one
// place this verifier differs from the contract-state one. A reserved slot's
// arming is visible server-side (the stored row carries the armed decision),
// so there the server's refusal is the signal to respect; the escrow leaf has
// no stored signal (an armed-but-idle domain and an inert one commit
// byte-identical roots), so the SDK's own carrier of the activation maps
// decides, and a proof whose height precedes the armed height is refused
// whatever the server said. A below-arming non-inclusion would "verify" and
// mean nothing (spec §4): zero-locked is only a real claim at armed heights.
// The height check is strict-parse fail-closed: a garbage height reads as
// not-armed, never as armed.
function verifyLockedBalanceProof(proof, trustedStateRoot, chain, network, expected){
    try {
        if (!proof || !proof.smt_proof || !proof.sub_root_path) return _no('MALFORMED_PROOF');
        if (_expectedMismatch(expected, proof)) return _no('REQUESTED_IDENTITY_MISMATCH');
        if (!SUB.isEscrowLockedLeafActive(proof.height, network, chain))
            return _no('ESCROW_LEAF_NOT_COMMITTED');
        // The proven key must be exactly escrowKey(chain, network, address, tick),
        // with chain/network from the TRUSTED checkpoint, never the proof.
        const keyBuf = M.escrowKey(chain, network, proof.address, proof.tick);
        if (_hx(proof.smt_proof.key) !== M.toHex(keyBuf)) return _no('KEY_MISMATCH');
        const leaf   = proof.smt_proof.leaf_value;
        const amount = M.canonicalAmount(proof.amount);
        if (leaf == null){
            if (amount !== M.canonicalAmount('0')) return _no('NONINCLUSION_NONZERO_AMOUNT');
        } else {
            // amountLeaf, the SAME encoding the spendable leaf uses, so a client
            // verifies both leaves of an (address, tick) the same way.
            if (M.toHex(M.amountLeaf(amount)) !== _hx(leaf)) return _no('LEAF_AMOUNT_MISMATCH');
        }
        if (!M.verifyCompressedSmtProof(proof.balances_root, keyBuf, leaf, proof.smt_proof.compressed))
            return _no('SMT_PROOF_INVALID');
        // PIN the slot (balances_root, the same slot the spendable proof pins),
        // for the same reason verifyBalanceProof does.
        if (proof.sub_root_path.index !== M.STATE_SUBTREES.indexOf('balances_root'))
            return _no('SUBROOT_SLOT_MISMATCH');
        if (!M.verifyFixedMerkleProof(trustedStateRoot, M.toBuf(proof.balances_root),
                                      proof.sub_root_path.index, proof.sub_root_path.siblings))
            return _no('SUBROOT_BIND_INVALID');
        return { verified: true, amount, reason: null };
    } catch (e){ return _no('VERIFY_ERROR:' + (e && e.message)); }
}

// Verify a contract-state proof binds to a TRUSTED state_root (SPV sub-tree spec
// §3 Stage A). Returns { verified, state_value, reason }.
//
// `state_value` is the RAW STORED STRING, not the JSON.parse'd form: the leaf is
// leafHash over those exact bytes, so parsing before hashing would false-reject.
// Callers parse AFTER verifying. A verified null means the key is not in the
// committed tree, which covers both "never written" and "deleted": the commitment
// itself does not distinguish them, so neither does this.
//
// THE CALLER MUST ESTABLISH THAT THE SLOT IS ARMED AT THIS HEIGHT. Nothing in a
// proof can tell you: an armed-but-empty slot and an inert slot commit the
// byte-identical EMPTY_SMT_ROOT (spec §2), so a non-inclusion result here means
// "not in the committed tree" and NOT "this contract has no such key" unless the
// slot is known to be live. Treating a below-arming non-inclusion as absence is
// exactly the mistake spec §4 forbids; the server refuses to serve those heights
// (CONTRACT_STATE_NOT_COMMITTED), and that refusal is the signal to respect.
function verifyContractStateProof(proof, trustedStateRoot, chain, network, expected){
    const no = (reason) => ({ verified: false, state_value: null, reason: reason });
    try {
        if (!proof || !proof.smt_proof || !proof.sub_root_path) return no('MALFORMED_PROOF');
        // Bind to the REQUESTED (contract_index, state_key) when the caller supplies
        // it. Without this a server answers a different key with a valid proof, which
        // is exactly what the explorer's double-decode did. See _expectedMismatch.
        if (_expectedMismatch(expected, proof)) return no('REQUESTED_IDENTITY_MISMATCH');
        // The proven key must be exactly contractStateKey(chain, network, index, key),
        // with chain/network from the TRUSTED checkpoint rather than the proof: a
        // server must not be able to answer for one key with another key's proof.
        const keyBuf = M.contractStateKey(chain, network, proof.contract_index, proof.state_key);
        if (_hx(proof.smt_proof.key) !== M.toHex(keyBuf)) return no('KEY_MISMATCH');

        const leaf = proof.smt_proof.leaf_value;
        const val  = (proof.state_value == null) ? null : String(proof.state_value);
        if (leaf == null){
            if (val !== null) return no('NONINCLUSION_WITH_VALUE');
        } else {
            if (val === null) return no('INCLUSION_WITHOUT_VALUE');
            // Binds the returned value to the committed leaf, so the server's
            // `state_value` cannot lie about what the contract stored.
            if (M.toHex(M.leafHash(val)) !== _hx(leaf)) return no('LEAF_VALUE_MISMATCH');
        }
        if (!M.verifyCompressedSmtProof(proof.contract_state_root, keyBuf, leaf, proof.smt_proof.compressed))
            return no('SMT_PROOF_INVALID');
        // PIN THE SLOT, for the same reason verifyBalanceProof does. Slots 2 and 3
        // are the constant EMPTY_SMT_ROOT today, so without this a server could
        // bind an EMPTY slot's path, hand back leaf_value:null, and "prove" that
        // any key is absent from a contract that in fact holds it.
        if (proof.sub_root_path.index !== M.STATE_SUBTREES.indexOf('contract_state_root'))
            return no('SUBROOT_SLOT_MISMATCH');
        if (!M.verifyFixedMerkleProof(trustedStateRoot, M.toBuf(proof.contract_state_root),
                                      proof.sub_root_path.index, proof.sub_root_path.siblings))
            return no('SUBROOT_BIND_INVALID');
        return { verified: true, state_value: val, reason: null };
    } catch (e){ return no('VERIFY_ERROR:' + (e && e.message)); }
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
    if (Number(proof.height) !== Number(cp.block_index))
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
    // Height comes from the quorum-signed checkpoint, not the response label (see verifyBalance).
    const base = { height: Number(cp.block_index), action: proof.action, action_index: Number(proof.action_index),
                   tx_index: (proof.tx_index == null) ? null : Number(proof.tx_index),
                   checkpoint: cp, quorum: q.quorum, weighted: q.weighted };
    if (!q.valid) return Object.assign({ verified: false, reason: 'CHECKPOINT_QUORUM_FAILED' }, base);
    // Bind the served proof to the served checkpoint in the server-served branch too;
    // actionProof emits height as Number(cp.block_index) for that same cp.
    if (Number(proof.height) !== Number(cp.block_index))
        return Object.assign({ verified: false, reason: 'PROOF_HEIGHT_MISMATCH' }, base);
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

// Shapes the checkpoint canonical assumes for the committed SPV roots: a 32-byte
// hex root and a non-negative integer version (both are stringified into the
// signed bytes, so anything else signs a different string than it reads as).
const ANCHOR_ROOT_RE    = /^[0-9a-f]{64}$/i;
const ANCHOR_VERSION_RE = /^\d+$/;

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
    const reject = (reason) => ({ verified: false, reason, checkpoint: cp, confirmations: safeConf, minDepth, quorum: null, weighted: null });
    // v3/v5 carry the committed roots; a rootless (v0/v4) anchor cannot serve SPV trust.
    // Empty counts as absent: parseAnchorV3 maps a missing wire field to '', not null.
    if (cp.state_root == null || cp.block_merkle_root == null
        || String(cp.state_root) === '' || String(cp.block_merkle_root) === '')
        return reject('NOT_A_V3_ANCHOR');
    // The roots are only INSIDE the signed bytes when canonicalCheckpoint appends
    // them, which needs commitment active and all four fields present (checkpoint.js
    // §6.1). Accepting on root presence alone let a legitimately signed pre-activation
    // rootless checkpoint be republished as a buried v3 carrying attacker-chosen roots:
    // the original signature still verifies against the rootless canonical, and SPV
    // adopts roots no validator ever signed. Mirror the append condition exactly.
    if (!ckptCommit.isCheckpointCommitmentActive(cp.snapshot_block, cp.network)
        || !ANCHOR_VERSION_RE.test(String(cp.state_root_version))
        || !ANCHOR_VERSION_RE.test(String(cp.block_merkle_version)))
        return reject('ROOTS_NOT_SIGNED');
    // Syntax the canonical assumes: a 32-byte hex root. A value of another shape
    // would sign one string and be consumed downstream as another.
    if (!ANCHOR_ROOT_RE.test(String(cp.state_root)) || !ANCHOR_ROOT_RE.test(String(cp.block_merkle_root)))
        return reject('MALFORMED_ROOT');
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
// verifyAnchoredCheckpoint result plus { anchor, dogeTxid, depthSource }.
//
// DEPTH IS TWO-TIER, like `validators` (module header). The trust-minimized tier
// takes the anchor's DOGE inclusion height from the caller's own DOGE source
// (dogeTxHeight, or getDogeTxHeight(txHash)) and IGNORES the explorer entirely.
// The convenience tier falls back to the record's block_index_doge, which is the
// EXPLORER's unverified claim about where its own anchor tx landed: a hostile
// explorer names any height it likes and mints any depth it likes, so the
// buried-anchor gate is forgeable on that tier and is a convenience, not a trust
// boundary. `depthSource` on the result reports which tier ran ('caller' or
// 'explorer'); pass requireTrustedDepth to refuse the convenience tier outright
// (reason UNTRUSTED_DOGE_DEPTH) rather than accept a depth nobody proved.
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
    // Inclusion height: caller's own DOGE source first, explorer claim only as fallback.
    let txHeight = opts.dogeTxHeight;
    if (txHeight == null && typeof opts.getDogeTxHeight === 'function')
        txHeight = await opts.getDogeTxHeight(rec.tx_hash || null);
    const depthSource  = (txHeight != null) ? 'caller' : 'explorer';
    if (opts.requireTrustedDepth && depthSource !== 'caller')
        return { verified: false, reason: 'UNTRUSTED_DOGE_DEPTH', checkpoint: anchorToCheckpoint(rec),
                 anchor: rec, dogeTxid: rec.tx_hash || null, confirmations: 0, minDepth,
                 quorum: null, weighted: null, depthSource };
    const anchorHeight = (txHeight != null) ? txHeight : rec.block_index_doge;
    const confirmations = (tip != null && anchorHeight != null)
        ? (Number(tip) - Number(anchorHeight) + 1) : NaN;
    const res = verifyAnchoredCheckpoint({ checkpoint: anchorToCheckpoint(rec), validators: opts.validators,
        confirmations, minDepth });
    return Object.assign({}, res, { anchor: rec, dogeTxid: rec.tx_hash || null, depthSource });
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
        // PIN the slot to stakes_root (index 1) for the same reason as the
        // balances path above: an unpinned index lets a server bind against an
        // empty slot. Here it is currently blocked only incidentally (an empty
        // sub-tree fails MEMBER_LEAF_MISMATCH downstream), so pin it explicitly.
        if (proof.sub_root_path.index !== M.STATE_SUBTREES.indexOf('stakes_root'))
            return { verified: false, capabilities: {}, reason: 'SUBROOT_SLOT_MISMATCH' };
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
// verifyValidatorSet). The verdict comes from the SINGLE shared predicate
// (swq.meetsStakeThreshold), never a local re-implementation: an earlier inline
// copy of the 3·Σ > 2·S math here silently dropped swq's blank-source,
// negative-weight, and truncated-snapshot fail-closed guards, so a blank-source
// snapshot (schema NOT NULL DEFAULT '') collapsed the threshold to 1-of-N.
// The committed __total__ leaf is demoted to a cross-check against
// swq.totalStake: a mismatch means the committed denominator disagrees with the
// proven set and must never finalize. Fully trustless: nothing here trusts a
// server-supplied set.
function verifyCheckpointWithProvenSet(cp, provenOraclePublish){
    // Post-activation a checkpoint MUST carry all four commitment fields, or
    // canonicalCheckpoint falls back to the legacy ROOTLESS preimage and the whole root
    // suffix drops out of the signed bytes. An explorer could then attach an
    // attacker-chosen state_root, omit a sibling field, and have rootless signatures
    // still verify - a root no validator ever signed, which followForward would adopt
    // and verifyBalance would trust. checkpoint.verifyCheckpoint already rejects this;
    // the same predicate, not a copy of it, has to hold here.
    if (checkpoint.commitmentMissing(cp)) return { valid: false, total: '0' };
    const canonical  = cp && checkpoint.canonicalCheckpoint(cp);
    const validators = (provenOraclePublish && provenOraclePublish.validators) || [];
    const provenPks  = new Set();
    for (const v of validators){
        if (v && v.pubkey !== null && v.pubkey !== undefined) provenPks.add(String(v.pubkey).toLowerCase());
    }
    let sigs = cp && cp.validator_signatures;
    if (typeof sigs === 'string'){ try { sigs = JSON.parse(sigs); } catch (e){ sigs = []; } }
    if (!Array.isArray(sigs)) sigs = [];
    const seenPk = new Set(), validSigners = [];
    for (const sig of sigs){
        const pk = String(sig && sig.pubkey || '').toLowerCase();
        if (seenPk.has(pk)) continue;
        if (!provenPks.has(pk)) continue;                         // signer not in the proven set
        if (!checkpoint.verifySignature(canonical, String(sig && sig.sig || ''), pk)) continue;
        // Only mark a pubkey "seen" once its signature actually verifies (matching
        // checkpoint.js#verifyCheckpoint): marking on first encounter would let a
        // garbage-then-valid pair of entries for the same proven signer suppress the
        // real signature (order-dependent quorum under-count, false-reject).
        seenPk.add(pk);
        validSigners.push(pk);
    }
    let valid = swq.meetsStakeThreshold(validators, validSigners);
    let total = '0';
    if (valid){
        // Cross-check the committed total against the proven set's deduped sum.
        // totalStake throws on the malformed-snapshot cases meetsStakeThreshold
        // already rejects, so a throw here (or a mismatch) fails CLOSED.
        try {
            total = M.canonicalAmount(String(swq.totalStake(validators)));
            const committed = M.canonicalAmount(String((provenOraclePublish && provenOraclePublish.total) || '0'));
            if (_scaled(total) !== _scaled(committed)) valid = false;
        } catch (e){ valid = false; }
    }
    return { valid, total };
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
            //
            // The checkpoint DECLARES the raw height the signing hub was handed, but
            // that hub resolved its oracle_publish set through CapabilitySnapshot, which buries
            // every height by CANONICAL_REORG_BUFFER first (tip stake state is not reorg-safe).
            // Proving the set at the declared height therefore proves a DIFFERENT set than the
            // one that signed whenever a validator's stake activated or deactivated inside
            // (snapshot_block - 6, snapshot_block], and a light client on that boundary either
            // rejects a valid checkpoint or counts a signer the hub never had. Bury by the same
            // shared constant. Flag-day gated (INERT on mainnet/testnet), so below the gate the
            // declared height is used verbatim and already-anchored checkpoints read as before.
            const setBlock = srb.buriedSnapshotBlock(next.snapshot_block, next.network);
            const vs = await verifyValidatorSet({ explorerUrl: opts.explorerUrl, btcCoin,
                snapshotBlock: setBlock, trustedStateRoot: _hx(trusted.state_root), fetchImpl: f });
            if (!vs.verified) return { trusted, adopted, reason: 'VALIDATOR_SET_UNVERIFIED@' + next.block_index, stoppedAt: next.block_index };
            const q = verifyCheckpointWithProvenSet(next, vs.capabilities.oracle_publish);
            if (!q.valid) return { trusted, adopted, reason: 'QUORUM_FAILED@' + next.block_index, stoppedAt: next.block_index };
            trusted = next; adopted.push(next);                   // roll the trust root forward
        }
    }
    return { trusted, adopted, reason: null, stoppedAt: null };
}

// Re-export the pinned-registry accessors so `sdk.light` is a COMPLETE SPV
// surface. A consumer that holds only an SDK instance (the reference wallet
// holds `sdk`, never the module namespace) otherwise cannot ask which trust
// tier a call will take: whether a pinned launch root covers this coin, or the
// call falls through to the explorer's /verify convenience path. That question
// decides how loudly a quorum failure should be reported, so the answer has to
// be reachable from the same object the verify calls are made on.
module.exports = {
    verifyBalanceProof,
    verifyLockedBalanceProof,
    verifyContractStateProof,
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
    followForward,
    getPinnedCheckpoint: pinned.getPinnedCheckpoint,
    getPinnedValidators: pinned.getPinnedValidators
};
