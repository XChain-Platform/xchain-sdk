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

function resolveFetch(impl){
    let f = impl || (typeof fetch === 'function' ? fetch : null);
    if (!f) throw new Error('LightClient: no fetch implementation available');
    return f;
}

// Keep the historical mainnet default only when no contrary network context
// exists. A caller that names testnet or regtest must also name that tier's coin.
function networkContextCoin(opts, field, mainnetCoin, fallbackNetwork){
    const coin = opts && opts[field];
    if (coin) return coin;
    const network = opts && opts.network != null ? opts.network : fallbackNetwork;
    const tier = String(network || '').toLowerCase().split('-').pop();
    if (tier === 'testnet' || tier === 'regtest')
        throw new Error('LightClient: ' + field + ' is required for ' + tier + ' network context');
    return mainnetCoin;
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
function pinnedEntry(opts, coin){
    if (opts.validators || opts.trustedCheckpoint) return null;
    const resolve = opts.pinnedResolver || pinned.getPinnedCheckpoint;
    return resolve(coin === undefined ? opts.coin : coin) || null;
}
// Trailing slashes trimmed by loop rather than /\/+$/: the quantified group
// backtracks polynomially on a long run of slashes in a caller-supplied URL.
function baseUrl(u){ let s = String(u || ''); while (s.endsWith('/')) s = s.slice(0, -1); return s; }
async function fetchJson(f, url){
    let r = await f(url);
    if (!r.ok) throw new Error('LightClient: explorer returned HTTP ' + r.status);
    return r.json();
}
function lowerHex(x){ return String(x == null ? '' : x).toLowerCase(); }

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
//
// undefined and null are NOT equivalent. undefined means the caller left the
// field out of `expected` (nothing to bind), so it is skipped exactly like a
// field that was never a key of the object. An explicit null on an identity
// field is never a legitimate "don't care": a caller only produces one via a
// bug (an unresolved lookup, a bad default), and a `continue` past it
// would bind nothing, i.e. verify a proof for a different identity than the
// caller thought it asked for. So it throws instead of skipping; every caller
// of expectedMismatch (proof_checks.js) runs inside a try/catch that turns a
// thrown error into an unverified/refused result, so this fails closed rather
// than passing with the field unchecked.
function expectedMismatch(expected, actual){
    if (!expected) return null;
    for (const field of Object.keys(expected)){
        const want = expected[field];
        if (want === undefined) continue;
        if (want === null) throw new TypeError('expectedMismatch: expected.' + field + ' is null, refusing to bind an unchecked identity field');
        if (String(want) !== String(actual[field])) return field;
    }
    return null;
}

// Runnable unit case for the null-refusal fix above:
//   node src/protocol/light_client/fetch_helpers.js
// Exits 0 and prints "ok" lines on success, exits 1 on any failure. Kept in
// this file because it is the only writable surface for this row.
if (require.main === module){
    let failures = 0;
    function check(name, fn){
        try { fn(); console.log('ok - ' + name); }
        catch (e){ failures++; console.error('not ok - ' + name + ': ' + (e && e.message)); }
    }
    check('a null expected field throws instead of being skipped (was: continue, bound nothing)', () => {
        let threw = null;
        try { expectedMismatch({ address: null }, { address: 'bc1qsomeoneelse' }); }
        catch (e){ threw = e; }
        if (!threw) throw new Error('expectedMismatch did not throw for a null expected.address');
        if (!(threw instanceof TypeError)) throw new Error('expected a TypeError, got ' + threw);
    });
    check('an undefined expected field is still skipped (back-compat, unchanged)', () => {
        const result = expectedMismatch({ address: undefined, tick: 'DOGE' }, { address: 'bc1qanything', tick: 'DOGE' });
        if (result !== null) throw new Error('expected no mismatch for an undefined field, got ' + result);
    });
    check('a genuine mismatch on a present field is still reported', () => {
        const result = expectedMismatch({ tick: 'DOGE' }, { tick: 'BTC' });
        if (result !== 'tick') throw new Error('expected mismatched field "tick", got ' + result);
    });
    check('a fully matching expected object still verifies clean', () => {
        const result = expectedMismatch({ tick: 'DOGE', address: 'bc1qsame' }, { tick: 'DOGE', address: 'bc1qsame' });
        if (result !== null) throw new Error('expected no mismatch, got ' + result);
    });
    if (failures > 0){
        console.error(failures + ' of 4 unit case(s) failed');
        process.exit(1);
    }
    console.log('all 4 fetch_helpers.js unit cases passed');
}

function unverified(reason){ return { verified: false, amount: null, reason: reason }; }
// ── Validator-set proof + forward-following (spec §7, Phase 5) ────────────────
// The keystone of a self-verifying client: instead of trusting an explorer for the
// signer set, the client PROVES each signer's (source, weight) and the source-deduped
// total S against a trusted, committed BTC `stakes_root`, then checks the weighted
// quorum `3·Σ(distinct signer-source weight) > 2·S` locally. Breaks the §7.1 circularity.

function scaled(a){ const [i, f] = M.canonicalAmount(String(a)).split('.'); return BigInt(i) * 1000000000000000000n + BigInt(f); }

module.exports = { resolveFetch, networkContextCoin, pinnedEntry, baseUrl, fetchJson, lowerHex, expectedMismatch, unverified, scaled };
