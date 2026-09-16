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

const checkpoint = require('../../checkpoint.js');
const { sameWireIndex } = require('../../utils/wire_index.js');
const { _base, _json, pinnedEntry, _hx } = require('./fetch_helpers.js');
const { followForward } = require('./validator_set_follow.js');

// ── Trust: turn a server-served checkpoint into a quorum-verified one ──────────

// Establish that `cp` meets quorum. `validators` (the qualifying oracle_publish
// set with { pubkey, weight, source }) is supplied out of band for the trust-
// minimized path; otherwise it is fetched from the explorer's verify endpoint
// (convenience, weaker: trusts the explorer for the SET, still verifies sigs +
// quorum locally). Returns the verifyCheckpoint result.
async function verifyQuorum(f, explorerUrl, coin, cp, suppliedValidators){
    const validators = suppliedValidators || await explorerValidators(f, explorerUrl, coin, cp);
    return checkpoint.verifyCheckpoint(cp, validators);
}

// Cache the explorer's /verify validator set per (explorer, coin, checkpoint
// height): a CLOSED checkpoint's signer set never changes, so repeat proofs at
// one height ask the same question; bounded so a long session can't grow it.
const VALIDATOR_SET_CACHE_MAX = 64;
const validatorSetCache = new Map();

// Reset the cache: for tests, and for any embedder that wants a clean slate
// without restarting the process.
function clearValidatorSetCache(){ validatorSetCache.clear(); }

// Tier 3 of the ladder on its own: ask the explorer which set qualifies for `cp`
// under the coin prefix `coin`. Trusts the explorer for the SET only; the caller
// still checks signatures and quorum locally. Transport failures throw.
//
// Cached by PROMISE so concurrent callers at one key (the wallet fans proof
// jobs through a pool of 6) share one in-flight read instead of each firing a
// request; a rejected fetch is evicted immediately so a blip is not pinned.
async function explorerValidators(f, explorerUrl, coin, cp){
    const key = _base(explorerUrl) + '|' + String(coin) + '|' + String(cp.block_index);
    const cached = validatorSetCache.get(key);
    if (cached) return cached;
    const url = _base(explorerUrl) + '/' + encodeURIComponent(String(coin)) +
                '/api/checkpoint/' + encodeURIComponent(String(cp.block_index)) + '/verify';
    const p = _json(f, url).then((vb) => (vb && vb.validators) || []);
    p.catch(() => { validatorSetCache.delete(key); });
    if (validatorSetCache.size >= VALIDATOR_SET_CACHE_MAX){
        const oldestKey = validatorSetCache.keys().next().value;
        validatorSetCache.delete(oldestKey);
    }
    validatorSetCache.set(key, p);
    return p;
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
async function resolveQuorum(f, opts, cp){
    if (opts.validators) return checkpoint.verifyCheckpoint(cp, opts.validators);
    const entry = pinnedEntry(opts);
    if (!entry) return verifyQuorum(f, opts.explorerUrl, opts.coin, cp, null);
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
        if (t && sameWireIndex(t.block_index, cp.block_index)
            && _hx(t.state_root) === _hx(cp.state_root)
            && _hx(t.block_merkle_root) === _hx(cp.block_merkle_root))
            return { valid: true, quorum: null, weighted: null };
    }
    return { valid: false, quorum: null, weighted: null };
}

// The same ladder, but returning the SET instead of a verdict, for the caller
// that must hand a set to a verifier which owns the quorum decision itself (the
// DOGE-anchor cold start, whose verifier also gates burial depth and the signed
// commitment fields). Order matches resolveQuorum: explicit set, then the
// pinned launch set for `coin`, then the explorer's /verify set.
//
// `coin` is the explorer coin prefix of the chain the CHECKPOINT belongs to,
// which is not always opts.coin. Returns null when no tier can name a set:
// callers must treat that as a quorum failure, never as an empty set, because
// verifyCheckpoint reads an empty qualified set as quorum 1 and then fails every
// checkpoint closed with a misleading count.
//
// A pinned entry without a usable set also returns null rather than falling
// through to /verify, for the reason resolveQuorum never falls through either:
// a coin whose trust root is pinned must not be silently downgraded to the
// explorer's word. Transport failures propagate (throw).
async function resolveValidatorSet(f, opts, cp, coin){
    if (opts.validators) return opts.validators;
    const entry = pinnedEntry(opts, coin);
    if (entry)
        return (Array.isArray(entry.validators) && entry.validators.length) ? entry.validators : null;
    if (coin == null || String(coin) === '') return null;
    return explorerValidators(f, opts.explorerUrl, coin, cp);
}

module.exports = { verifyQuorum, VALIDATOR_SET_CACHE_MAX, validatorSetCache, clearValidatorSetCache, explorerValidators, resolveQuorum, resolveValidatorSet };
