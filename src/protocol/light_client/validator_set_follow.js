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

const M          = require('../../merkle.js');
const checkpoint = require('../../checkpoint.js');
const swq        = require('../../stake_weighted_quorum.js');
const srb        = require('../../snapshot_reorg_buffer.js');
const { resolveFetch, baseUrl, fetchJson, scaled, lowerHex } = require('./fetch_helpers.js');
const { verifyValidatorSetProof } = require('./proof_checks.js');

// Network: fetch + verify the validator-set proof at BTC snapshot height S.
async function verifyValidatorSet(opts){
    opts = opts || {};
    const f = resolveFetch(opts.fetchImpl);
    const url = baseUrl(opts.explorerUrl) + '/' + encodeURIComponent(String(opts.btcCoin || 'BTC')) +
                '/api/proof/validator-set?height=' + encodeURIComponent(String(opts.snapshotBlock));
    const body = await fetchJson(f, url);
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
            if (scaled(total) !== scaled(committed)) valid = false;
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
    const f = resolveFetch(opts.fetchImpl);
    const btcCoin = opts.btcCoin || 'BTC';
    let trusted = opts.trustedCheckpoint;
    if (!trusted || trusted.state_root == null) throw new Error('LightClient: followForward needs a trusted BTC checkpoint with a committed state_root');
    const from = Number(trusted.block_index) + 1;
    const to   = Number(opts.toHeight != null ? opts.toHeight : trusted.block_index);
    const adopted = [];
    if (to >= from){
        const rangeUrl = baseUrl(opts.explorerUrl) + '/' + encodeURIComponent(String(btcCoin)) +
                         '/api/checkpoints/range?from=' + from + '&to=' + to;
        const rangeBody = await fetchJson(f, rangeUrl);
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
                snapshotBlock: setBlock, trustedStateRoot: lowerHex(trusted.state_root), fetchImpl: f });
            if (!vs.verified) return { trusted, adopted, reason: 'VALIDATOR_SET_UNVERIFIED@' + next.block_index, stoppedAt: next.block_index };
            const q = verifyCheckpointWithProvenSet(next, vs.capabilities.oracle_publish);
            if (!q.valid) return { trusted, adopted, reason: 'QUORUM_FAILED@' + next.block_index, stoppedAt: next.block_index };
            trusted = next; adopted.push(next);                   // roll the trust root forward
        }
    }
    return { trusted, adopted, reason: null, stoppedAt: null };
}

module.exports = { verifyValidatorSet, verifyCheckpointWithProvenSet, followForward };
