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

const pinned = require('./pinned_checkpoints.js');
const { verifyBalanceProof, verifyLockedBalanceProof, verifyContractStateProof,
    verifyActionProof, verifyValidatorSetProof } = require('./light_client/proof_checks.js');
const { verifyBalance, verifyLockedBalance, verifyAction } = require('./light_client/online_verify.js');
const { parseAnchorV0, anchorBundleSection, anchorToCheckpoint, verifyAnchoredCheckpoint,
    fetchAnchoredCheckpoint } = require('./light_client/anchored_checkpoint.js');
const { verifyValidatorSet, verifyCheckpointWithProvenSet,
    followForward } = require('./light_client/validator_set_follow.js');
const { clearValidatorSetCache } = require('./light_client/quorum_resolution.js');

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
    verifyLockedBalance,
    verifyAction,
    parseAnchorV0,
    anchorBundleSection,
    anchorToCheckpoint,
    verifyAnchoredCheckpoint,
    fetchAnchoredCheckpoint,
    verifyValidatorSetProof,
    verifyValidatorSet,
    verifyCheckpointWithProvenSet,
    followForward,
    getPinnedCheckpoint: pinned.getPinnedCheckpoint,
    getPinnedValidators: pinned.getPinnedValidators,
    clearValidatorSetCache
};
