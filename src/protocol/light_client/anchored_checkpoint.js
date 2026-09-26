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
// The CHECKPOINT_COMMITMENT flag day is a registry row read by its literal key (W5);
// the predicate is activeAt over the checkpoint's BTC-anchored snapshot_block, the
// same read checkpoint.js makes when it appends the roots to the signed canonical.
const gateRegistry = require('../../consensus/gate_registry');
const CHECKPOINT_COMMITMENT_KEY = 'checkpoint_commitment_activation.CHECKPOINT_COMMITMENT_ACTIVATION';
const { lowerHex, resolveFetch, networkContextCoin, baseUrl, fetchJson } = require('./fetch_helpers.js');
const { resolveValidatorSet } = require('./quorum_resolution.js');

// Default DOGE confirmation depth a cold-start anchor must be buried under before
// it is trusted. DOGE blocks ~1 min and ANCHORs land ~daily, so a recent valid
// anchor is normally far deeper than this; callers SHOULD set their own policy.
const DEFAULT_ANCHOR_MIN_DEPTH = 60;
// ── DOGE-anchor cold-start trust (spec §7.2 b / D4) ───────────────────────────
// A client with no prior trust root bootstraps from the on-chain ANCHOR: read the
// latest root-bearing ANCHOR v0 bundle off DOGE, confirm it is buried under a
// chosen PoW depth, and adopt the quorum-signed checkpoint of the section for the
// chain it cares about. Trust still bottoms out at the federation quorum (the DOGE
// PoW only hardens delivery/timing, §7.4); the SDK has no DOGE backend, so the
// caller supplies the confirmation depth from its own DOGE source.

// The single-wire ANCHOR family (anchor-v0-single-wire spec §2.1) is three
// version-disjoint shapes on one wire:
//
//   v0 is the checkpoint BUNDLE: one anchor per network per cycle carrying every
//   chain's checkpoint as a section (this is what parseAnchorV0 below parses;
//   this constant was ANCHOR_BUNDLE_VERSION = 7 before the 2026-08-30 flag day):
//
//     ANCHOR|0|NETWORK|SNAPSHOT_BLOCK|SECTION_COUNT
//       {CHAIN|BLOCK_INDEX|BLOCK_HASH|LEDGER_HASH|ACTIONS_HASH|CONTRACT_HASH
//        |CHECKPOINT_SEQ|SECTION_SNAPSHOT_BLOCK|STATE_ROOT|STATE_ROOT_VERSION
//        |BLOCK_MERKLE_ROOT|BLOCK_MERKLE_VERSION|SIG_COUNT|(PUBKEY|SIG)...} x N
//       |PUBLISHER|ATTEST_SIG_COUNT|(APUBKEY|ASIG)...
//
//   v1 is the archive head plus its publisher tail (ATTEST_SIG_COUNT MAY be 0 on
//   a degraded round); v2 is an archive continuation chunk. Neither carries an SPV
//   checkpoint, so the light client SKIPS both: only v0 bundle rows are ever
//   passed to parseAnchorV0 or accepted by the fetchAnchoredCheckpoint filter.
//
//   ACTIVATION: an ANCHOR of any version mined below ANCHOR_ACTIVATION[network]
//   (protocol/constants.js, which carries the per-network heights and why the
//   mainnet one sits above the chain tip) is invalid on the wire and never
//   reaches this parser; at/above it only 0/1/2 exist. The SDK trusts the
//   indexer/explorer to have already applied that gate.
//
// Sections are variable-width (their signature lists differ), so the bundle is
// walked with a cursor rather than read at the fixed offsets the retired v3/v5
// single-chain wires allowed. Versions 1/2 are skipped as above; the pre-launch
// v0/v3/v4/v5 per-chain wires (a disjoint, now-retired numbering that predates
// this family, D2) are refused by the version check below.
const ANCHOR_BUNDLE_VERSION = 0;

// Parse an ANCHOR v0 bundle wire string (optional leading "ANCHOR|") into
// { version, network, snapshot_block, section_count, sections, publisher,
//   publisher_attestations }, where each section is the checkpoint shape
// sdk.checkpoint.verifyCheckpoint consumes. Pure; for callers who decode the raw
// DOGE transaction themselves. Throws on a malformed / non-v0 string.
//
// A section omits NETWORK on the wire, so every section takes the HEADER network:
// that is the string the signed per-chain canonical (XCHECKPOINT|CHAIN|NETWORK|...)
// was built with, and taking it from anywhere else would verify a different
// canonical than the validators signed.
function parseAnchorV0(wire){
    let p = String(wire || '').split('|');
    if (p.length && /^anchor$/i.test(p[0])) p = p.slice(1);
    const ver = String(p[0]);
    if (ver !== String(ANCHOR_BUNDLE_VERSION))
        throw new Error('LightClient: not an ANCHOR bundle (need v0, got VERSION ' + p[0] + ')');
    const network = String(p[1] || '');
    const snapshotBlock = Number(p[2]);
    const count = parseInt(p[3], 10);
    if (!Number.isFinite(count) || count < 1) throw new Error('LightClient: bad ANCHOR SECTION_COUNT');
    let i = 4;
    const sections = [];
    for (let s = 0; s < count; s++){
        // 13 fixed section fields (CHAIN..BLOCK_MERKLE_VERSION) then SIG_COUNT.
        if (i + 12 >= p.length) throw new Error('LightClient: truncated ANCHOR section ' + s);
        const sec = {
            chain: String(p[i] || '').toUpperCase(), network,
            block_index: Number(p[i + 1]), block_hash: lowerHex(p[i + 2]),
            ledger_hash: lowerHex(p[i + 3]), actions_hash: lowerHex(p[i + 4]), contract_hash: lowerHex(p[i + 5]),
            checkpoint_seq: Number(p[i + 6]), snapshot_block: Number(p[i + 7]),
            state_root: lowerHex(p[i + 8]), state_root_version: Number(p[i + 9]),
            block_merkle_root: lowerHex(p[i + 10]), block_merkle_version: Number(p[i + 11]),
            validator_signatures: []
        };
        const n = parseInt(p[i + 12], 10);
        if (!Number.isFinite(n) || n < 1) throw new Error('LightClient: bad ANCHOR SIG_COUNT in section ' + s);
        i += 13;
        for (let k = 0; k < n; k++){
            const pubkey = p[i], sig = p[i + 1];
            if (!pubkey || !sig) throw new Error('LightClient: missing ANCHOR sig at section ' + s + ' index ' + k);
            sec.validator_signatures.push({ pubkey: String(pubkey).toLowerCase(), sig: String(sig).toLowerCase() });
            i += 2;
        }
        sections.push(sec);
    }
    // Tail: one publisher attestation for the whole bundle. It is a reward
    // artifact, not part of SPV trust, and a degraded round legitimately lands
    // ATTEST_SIG_COUNT 0, so an absent or empty tail is not an error.
    const publisher = lowerHex(p[i]) || null;
    const attestCount = parseInt(p[i + 1], 10);
    const attestations = [];
    if (Number.isFinite(attestCount) && attestCount > 0){
        let j = i + 2;
        for (let k = 0; k < attestCount; k++){
            const pubkey = p[j], sig = p[j + 1];
            if (!pubkey || !sig) throw new Error('LightClient: missing ANCHOR attestation at index ' + k);
            attestations.push({ pubkey: String(pubkey).toLowerCase(), sig: String(sig).toLowerCase() });
            j += 2;
        }
    }
    return {
        version: ANCHOR_BUNDLE_VERSION, network, snapshot_block: snapshotBlock,
        section_count: count, sections, publisher, publisher_attestations: attestations
    };
}

// Pick one chain's section out of a parsed bundle (or a raw v0 wire) as the
// normalized checkpoint verifyAnchoredCheckpoint consumes. Returns null when the
// bundle carries no section for that chain, which is the NORMAL daily case for a
// chain that cut no new checkpoint (spec D4), not an error.
function anchorBundleSection(bundle, chain){
    const b = (typeof bundle === 'string') ? parseAnchorV0(bundle) : bundle;
    if (!b || !Array.isArray(b.sections)) throw new Error('LightClient: not a parsed ANCHOR bundle');
    const want = String(chain || '').toUpperCase();
    return b.sections.find(s => String(s.chain).toUpperCase() === want) || null;
}

// Normalize an explorer /api/anchors record (a full row) into the checkpoint shape.
// Under v0 the explorer serves ONE row per section, each carrying its own chain,
// the header network and its own roots and signatures, so this mapping is
// unchanged from the one-anchor-per-chain era.
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
// object (a v0 section from anchorBundleSection, or anchorToCheckpoint on an
// explorer section row), which MUST carry the committed roots;
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
    // Every v0 section is root-bearing by construction; a rootless row (a pre-launch
    // retired per-chain shape, or a section the hub should have skipped) cannot serve SPV trust.
    // Empty counts as absent: the parser maps a missing wire field to '', not null.
    // The reason string keeps its shipped NOT_A_V3_ANCHOR spelling: it is a public
    // result contract, and it still names the same condition (no committed roots).
    if (cp.state_root == null || cp.block_merkle_root == null
        || String(cp.state_root) === '' || String(cp.block_merkle_root) === '')
        return reject('NOT_A_V3_ANCHOR');
    // The roots are only INSIDE the signed bytes when canonicalCheckpoint appends
    // them, which needs commitment active and all four fields present (checkpoint.js
    // §6.1). Accepting on root presence alone let a legitimately signed pre-activation
    // rootless checkpoint be republished as a buried v3 carrying attacker-chosen roots:
    // the original signature still verifies against the rootless canonical, and SPV
    // adopts roots no validator ever signed. Mirror the append condition exactly.
    if (!gateRegistry.activeAt(CHECKPOINT_COMMITMENT_KEY, cp.network, null, cp.snapshot_block, null)
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

// Convenience: fetch the latest root-bearing ANCHOR section for `targetChain` from the
// DOGE explorer, confirm its DOGE depth (caller supplies the tip via dogeTipHeight or
// getDogeTipHeight), and verify it. Anchors are DOGE-only, so the list is served by the
// DOGE explorer; each record's `chain` is the chain whose checkpoint it commits. A v0
// bundle is served as one row PER SECTION, so the per-chain filter below is exactly the
// one that ran when each chain had its own anchor. Returns the
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
//
// THE SIGNER SET follows the same ladder as every other network call
// (resolveValidatorSet). `targetCoin` names the explorer coin prefix of
// `targetChain` for the pinned lookup and the /verify fetch; omit it only when
// `validators` is supplied, since without either the call fails closed with
// CHECKPOINT_QUORUM_FAILED.
async function fetchAnchoredCheckpoint(opts){
    opts = opts || {};
    const dogeCoin = networkContextCoin(opts, 'dogeCoin', 'DOGE');
    const f = resolveFetch(opts.fetchImpl);
    const minDepth = (opts.minDepth != null) ? Number(opts.minDepth) : DEFAULT_ANCHOR_MIN_DEPTH;
    const url = baseUrl(opts.explorerUrl) + '/' + encodeURIComponent(String(dogeCoin)) +
                '/api/anchors/' + encodeURIComponent(String(opts.targetChain)) + '/chain';
    const body = await fetchJson(f, url);
    let rows = Array.isArray(body) ? body : ((body && (body.data || body.results || body.rows)) || []);
    // v0 section rows only (the checkpoint bundle, spec anchor-v0-single-wire §2.1);
    // v1 (archive head) and v2 (chunk) carry no SPV checkpoint and are skipped here,
    // as is any pre-launch retired per-chain shape, rather than filtered by root
    // presence, so a replayed pre-launch anchor cannot serve as a trust root; the
    // state_root check still guards a malformed section.
    rows = rows.filter(r => r && Number(r.version) === ANCHOR_BUNDLE_VERSION && r.state_root &&
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
    const cp = anchorToCheckpoint(rec);
    // Resolve the signer set through the SAME ladder every other network entry
    // point uses. Handing verifyAnchoredCheckpoint `opts.validators` raw meant a
    // caller that supplied none was verified against an empty set, which reads as
    // quorum 1 and fails a checkpoint the explorer's own set clears 4-of-5.
    //
    // The ladder keys on `targetCoin`, not the DOGE coin above: the anchor is read
    // off DOGE, but the checkpoint inside it belongs to the target chain, so the
    // pinned lookup and the /verify URL must both name the TARGET chain's explorer
    // coin prefix. Nothing maps a chain plus network back to a coin, so with no
    // explicit set, nothing pinned and no targetCoin, the set stays null and the
    // call fails closed on quorum rather than guessing a prefix from the chain name.
    const targetCoin = (opts.targetCoin == null || String(opts.targetCoin) === '') ? null : opts.targetCoin;
    const validators = await resolveValidatorSet(f, opts, cp, targetCoin);
    const res = verifyAnchoredCheckpoint({ checkpoint: cp, validators, confirmations, minDepth });
    return Object.assign({}, res, { anchor: rec, dogeTxid: rec.tx_hash || null, depthSource });
}

module.exports = { DEFAULT_ANCHOR_MIN_DEPTH, ANCHOR_BUNDLE_VERSION, parseAnchorV0, anchorBundleSection, anchorToCheckpoint, ANCHOR_ROOT_RE, ANCHOR_VERSION_RE, verifyAnchoredCheckpoint, fetchAnchoredCheckpoint };
