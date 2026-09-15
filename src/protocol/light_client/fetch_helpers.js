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

const M      = require('../../merkle.js');
const pinned = require('../pinned_checkpoints.js');

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
//
// `coin` names the registry key to look up. It defaults to opts.coin, which is
// the right key for every proof call, but the anchor cold start reads a DOGE
// endpoint for a checkpoint belonging to ANOTHER chain, so that caller passes
// the target chain's coin prefix explicitly.
function _pinnedEntry(opts, coin){
    if (opts.validators || opts.trustedCheckpoint) return null;
    const resolve = opts.pinnedResolver || pinned.getPinnedCheckpoint;
    return resolve(coin === undefined ? opts.coin : coin) || null;
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
// get the binding. Omitting it is DEPRECATED: the argument becomes required at
// the next major version, so new callers should always pass it. Only the fields
// present are compared, each as a string, so a numeric contract_index and its
// decimal spelling agree.
function _expectedMismatch(expected, actual){
    if (!expected) return null;
    for (const field of Object.keys(expected)){
        const want = expected[field];
        if (want === undefined || want === null) continue;
        if (String(want) !== String(actual[field])) return field;
    }
    return null;
}
function _no(reason){ return { verified: false, amount: null, reason: reason }; }
// ── Validator-set proof + forward-following (spec §7, Phase 5) ────────────────
// The keystone of a self-verifying client: instead of trusting an explorer for the
// signer set, the client PROVES each signer's (source, weight) and the source-deduped
// total S against a trusted, committed BTC `stakes_root`, then checks the weighted
// quorum `3·Σ(distinct signer-source weight) > 2·S` locally. Breaks the §7.1 circularity.

function _scaled(a){ const [i, f] = M.canonicalAmount(String(a)).split('.'); return BigInt(i) * 1000000000000000000n + BigInt(f); }

module.exports = { _fetch, _pinnedEntry, _base, _json, _hx, _expectedMismatch, _no, _scaled };
