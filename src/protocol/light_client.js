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
const { parseAnchorV0, anchorBundleSection: anchorBundleSectionV0, anchorToCheckpoint, verifyAnchoredCheckpoint,
    fetchAnchoredCheckpoint } = require('./light_client/anchored_checkpoint.js');
const { lowerHex } = require('./light_client/fetch_helpers.js');
const { verifyValidatorSet, verifyCheckpointWithProvenSet,
    followForward } = require('./light_client/validator_set_follow.js');
const { clearValidatorSetCache } = require('./light_client/quorum_resolution.js');

const ANCHOR_FOLD_VERSION = 3;

function parseAnchorV3Section(parts, start, network, sectionIndex){
    if (start + 12 >= parts.length)
        throw new Error('LightClient: truncated ANCHOR section ' + sectionIndex);
    const section = {
        chain: String(parts[start] || '').toUpperCase(), network,
        block_index: Number(parts[start + 1]), block_hash: lowerHex(parts[start + 2]),
        ledger_hash: lowerHex(parts[start + 3]), actions_hash: lowerHex(parts[start + 4]),
        contract_hash: lowerHex(parts[start + 5]), checkpoint_seq: Number(parts[start + 6]),
        snapshot_block: Number(parts[start + 7]), state_root: lowerHex(parts[start + 8]),
        state_root_version: Number(parts[start + 9]), block_merkle_root: lowerHex(parts[start + 10]),
        block_merkle_version: Number(parts[start + 11]), validator_signatures: []
    };
    const signatureCount = parseInt(parts[start + 12], 10);
    if (!Number.isFinite(signatureCount) || signatureCount < 1)
        throw new Error('LightClient: bad ANCHOR SIG_COUNT in section ' + sectionIndex);
    let next = start + 13;
    for (let k = 0; k < signatureCount; k++){
        const pubkey = parts[next], sig = parts[next + 1];
        if (!pubkey || !sig)
            throw new Error('LightClient: missing ANCHOR sig at section ' + sectionIndex + ' index ' + k);
        section.validator_signatures.push({
            pubkey: String(pubkey).toLowerCase(), sig: String(sig).toLowerCase()
        });
        next += 2;
    }
    return { section, next };
}

function parseAnchorV3Tail(parts, start){
    const publisher = lowerHex(parts[start]) || null;
    const countToken = parts[start + 1];
    if (!/^\d+$/.test(String(countToken == null ? '' : countToken)))
        throw new Error('LightClient: bad ANCHOR ATTEST_SIG_COUNT');
    const count = Number(countToken);
    const publisherAttestations = [];
    let next = start + 2;
    for (let k = 0; k < count; k++){
        const pubkey = parts[next], sig = parts[next + 1];
        if (!pubkey || !sig)
            throw new Error('LightClient: missing ANCHOR attestation at index ' + k);
        publisherAttestations.push({
            pubkey: String(pubkey).toLowerCase(), sig: String(sig).toLowerCase()
        });
        next += 2;
    }
    if (next !== parts.length) throw new Error('LightClient: trailing ANCHOR v3 fields');
    return { publisher, publisherAttestations };
}

function parseAnchorV3(wire){
    let parts = String(wire || '').split('|');
    if (parts.length && /^anchor$/i.test(parts[0])) parts = parts.slice(1);
    if (String(parts[0]) !== String(ANCHOR_FOLD_VERSION))
        throw new Error('LightClient: not an ANCHOR v3 bundle (got VERSION ' + parts[0] + ')');
    const network = String(parts[1] || '');
    const snapshotBlock = Number(parts[2]);
    const sectionCount = parseInt(parts[3], 10);
    if (!Number.isFinite(sectionCount) || sectionCount < 1)
        throw new Error('LightClient: bad ANCHOR SECTION_COUNT');
    let next = 4;
    const sections = [];
    for (let s = 0; s < sectionCount; s++){
        const parsed = parseAnchorV3Section(parts, next, network, s);
        sections.push(parsed.section);
        next = parsed.next;
    }
    const archiveCountToken = parts[next++];
    if (!/^(0|1)$/.test(String(archiveCountToken == null ? '' : archiveCountToken)))
        throw new Error('LightClient: invalid: ARCHIVE_COUNT');
    const archiveCount = Number(archiveCountToken);
    let archive = null;
    if (archiveCount === 1){
        const wrapperToken = parts[next++];
        if (!/^\d+$/.test(String(wrapperToken == null ? '' : wrapperToken)))
            throw new Error('LightClient: invalid: WRAPPER_SECTION_INDEX');
        const wrapperSectionIndex = Number(wrapperToken);
        if (wrapperSectionIndex < 0 || wrapperSectionIndex >= sections.length)
            throw new Error('LightClient: invalid: WRAPPER_SECTION_INDEX');
        if (next + 4 >= parts.length) throw new Error('LightClient: invalid: ARCHIVE_COUNT');
        archive = {
            wrapper_section_index: wrapperSectionIndex,
            match_batch_seq: Number(parts[next]), match_count: Number(parts[next + 1]),
            batch_crc32: lowerHex(parts[next + 2]), total_chunks: Number(parts[next + 3]),
            archive_b64: String(parts[next + 4] || '')
        };
        next += 5;
    }
    const tail = parseAnchorV3Tail(parts, next);
    return {
        version: ANCHOR_FOLD_VERSION, network, snapshot_block: snapshotBlock,
        section_count: sectionCount, sections, archive_count: archiveCount, archive,
        publisher: tail.publisher, publisher_attestations: tail.publisherAttestations
    };
}

function anchorBundleSection(bundle, chain){
    if (typeof bundle !== 'string') return anchorBundleSectionV0(bundle, chain);
    const parts = String(bundle || '').split('|');
    const version = /^anchor$/i.test(parts[0]) ? parts[1] : parts[0];
    return anchorBundleSectionV0(version === String(ANCHOR_FOLD_VERSION) ? parseAnchorV3(bundle) : bundle, chain);
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
    verifyLockedBalance,
    verifyAction,
    parseAnchorV0,
    parseAnchorV3,
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
