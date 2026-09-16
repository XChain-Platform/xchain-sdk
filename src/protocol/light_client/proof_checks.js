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

const M   = require('../../merkle.js');
const SUB = require('../../consensus/gates/state_subtree_gate.js');
const { sameWireIndex, toWireIndex } = require('../../utils/wire_index.js');
const { lowerHex, expectedMismatch, unverified } = require('./fetch_helpers.js');

// Verify a §4.4 BalanceProof binds to a TRUSTED state_root (one already proven to
// be in a quorum-signed checkpoint). chain/network come from the trusted
// checkpoint, never the proof. Returns { verified, amount, reason }.
//
// @param {Object} [expected] The REQUESTED { address, tick } to bind the proof to
//   (see expectedMismatch). @deprecated Calling without `expected` is deprecated;
//   the argument becomes required at the next major version.
function verifyBalanceProof(proof, trustedStateRoot, chain, network, expected){
    try {
        if (!proof || !proof.smt_proof || !proof.sub_root_path) return unverified('MALFORMED_PROOF');
        // Bind to the REQUESTED (address, tick) when the caller supplies it; the
        // check below only proves the proof is self-consistent. See expectedMismatch.
        if (expectedMismatch(expected, proof)) return unverified('REQUESTED_IDENTITY_MISMATCH');
        // The proven key must be exactly balanceKey(chain, network, address, tick):
        // a server cannot answer for (A,T) with a proof for some other key.
        const keyBuf    = M.balanceKey(chain, network, proof.address, proof.tick);
        if (lowerHex(proof.smt_proof.key) !== M.toHex(keyBuf)) return unverified('KEY_MISMATCH');
        const leaf   = proof.smt_proof.leaf_value;             // hex string or null (non-inclusion)
        const amount = M.canonicalAmount(proof.amount);
        if (leaf == null){
            if (amount !== M.canonicalAmount('0')) return unverified('NONINCLUSION_NONZERO_AMOUNT');
        } else {
            // The committed leaf must be exactly amountLeaf(amount): binds the
            // returned amount to the proof, so the server's `amount` cannot lie.
            if (M.toHex(M.amountLeaf(amount)) !== lowerHex(leaf)) return unverified('LEAF_AMOUNT_MISMATCH');
        }
        // The SMT proof must reconstruct the claimed balances_root...
        if (!M.verifyCompressedSmtProof(proof.balances_root, keyBuf, leaf, proof.smt_proof.compressed))
            return unverified('SMT_PROOF_INVALID');
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
            return unverified('SUBROOT_SLOT_MISMATCH');
        if (!M.verifyFixedMerkleProof(trustedStateRoot, M.toBuf(proof.balances_root),
                                      proof.sub_root_path.index, proof.sub_root_path.siblings))
            return unverified('SUBROOT_BIND_INVALID');
        return { verified: true, amount, reason: null };
    } catch (e){ return unverified('VERIFY_ERROR:' + (e && e.message)); }
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
//
// THE HEIGHT THE GATE READS IS NEVER `proof.height`. That field is authored by
// the explorer and is not hashed into anything, exactly like `proof.chain` and
// `proof.network`, which this verifier already refuses to source from. Keying
// the arming decision on it handed the decision back to the server the comment
// above says is not trusted: a proof LABELLED at or above the armed height whose
// non-inclusion is genuinely computed against a pre-arming balances_root passes
// every remaining check and returns verified:true, amount:'0' - a proven-looking
// "nothing is locked" for a height at which the ESC domain was never committed.
//
// So the gate reads `trustedHeight`, which callers take from the quorum-signed
// checkpoint beside `trustedStateRoot`, and `proof.height` must equal it or the
// proof is answering about a different block (PROOF_HEIGHT_MISMATCH, the same
// binding verifyBalance/verifyAction enforce in their network wrappers).
//
// A caller that supplies no trustedHeight is gated at height 0 rather than at the
// label. _atOrAfter is monotone in the height, so height 0 is the strictest
// possible reading: it verifies only where the leaf is armed from genesis, i.e.
// where the answer cannot depend on the height at all. That keeps the pre-
// trustedHeight callers working on the testnets (armed at 0) while refusing every
// chain with a mid-chain arming height, which is precisely the window the label
// could have lied about.
//
// @param {Object} [expected] The REQUESTED { address, tick } to bind the proof to
//   (see expectedMismatch). @deprecated Calling without `expected` is deprecated;
//   the argument becomes required at the next major version.
// @param {number|string} [trustedHeight] block_index of the TRUSTED checkpoint.
//   @deprecated Omitting it is deprecated and gates at height 0; it becomes
//   required at the next major version.
function verifyLockedBalanceProof(proof, trustedStateRoot, chain, network, expected, trustedHeight){
    try {
        if (!proof || !proof.smt_proof || !proof.sub_root_path) return unverified('MALFORMED_PROOF');
        if (expectedMismatch(expected, proof)) return unverified('REQUESTED_IDENTITY_MISMATCH');
        // The label must still PARSE as a wire index, strict, fail-closed. It no
        // longer decides anything, but a server that cannot even name the height it
        // is answering about has produced a proof nobody can place, and letting that
        // through would drop the strict-parse rule the header states.
        const label = toWireIndex(proof.height);
        if (label === null) return unverified('ESCROW_LEAF_NOT_COMMITTED');
        const haveTrustedHeight = (trustedHeight !== undefined && trustedHeight !== null
                                   && trustedHeight !== '');
        if (haveTrustedHeight && !sameWireIndex(label, trustedHeight))
            return unverified('PROOF_HEIGHT_MISMATCH');
        // Gate on the TRUSTED height. Past the bind above `label` IS that height,
        // so reuse it: the activation carrier's own strict parse takes only a
        // number or a digit string, and a BigInt block_index - the shape a
        // BIGINT column arrives in, and the shape wire_index.js exists to carry -
        // would read as NaN there and refuse an armed chain. Normalizing here
        // keeps the refusal for a height the carrier genuinely cannot compare
        // (above 2^53) and drops it for the ones it can.
        const gateWire   = haveTrustedHeight ? label : 0n;
        const gateHeight = (gateWire <= BigInt(Number.MAX_SAFE_INTEGER)) ? Number(gateWire) : NaN;
        if (!SUB.isEscrowLockedLeafActive(gateHeight, network, chain))
            return unverified('ESCROW_LEAF_NOT_COMMITTED');
        // The proven key must be exactly escrowKey(chain, network, address, tick),
        // with chain/network from the TRUSTED checkpoint, never the proof.
        const keyBuf = M.escrowKey(chain, network, proof.address, proof.tick);
        if (lowerHex(proof.smt_proof.key) !== M.toHex(keyBuf)) return unverified('KEY_MISMATCH');
        const leaf   = proof.smt_proof.leaf_value;
        const amount = M.canonicalAmount(proof.amount);
        if (leaf == null){
            if (amount !== M.canonicalAmount('0')) return unverified('NONINCLUSION_NONZERO_AMOUNT');
        } else {
            // amountLeaf, the SAME encoding the spendable leaf uses, so a client
            // verifies both leaves of an (address, tick) the same way.
            if (M.toHex(M.amountLeaf(amount)) !== lowerHex(leaf)) return unverified('LEAF_AMOUNT_MISMATCH');
        }
        if (!M.verifyCompressedSmtProof(proof.balances_root, keyBuf, leaf, proof.smt_proof.compressed))
            return unverified('SMT_PROOF_INVALID');
        // PIN the slot (balances_root, the same slot the spendable proof pins),
        // for the same reason verifyBalanceProof does.
        if (proof.sub_root_path.index !== M.STATE_SUBTREES.indexOf('balances_root'))
            return unverified('SUBROOT_SLOT_MISMATCH');
        if (!M.verifyFixedMerkleProof(trustedStateRoot, M.toBuf(proof.balances_root),
                                      proof.sub_root_path.index, proof.sub_root_path.siblings))
            return unverified('SUBROOT_BIND_INVALID');
        return { verified: true, amount, reason: null };
    } catch (e){ return unverified('VERIFY_ERROR:' + (e && e.message)); }
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
//
// @param {Object} [expected] The REQUESTED { contract_index, state_key } to bind
//   the proof to (see expectedMismatch). @deprecated Calling without `expected`
//   is deprecated; the argument becomes required at the next major version.
function verifyContractStateProof(proof, trustedStateRoot, chain, network, expected){
    const no = (reason) => ({ verified: false, state_value: null, reason: reason });
    try {
        if (!proof || !proof.smt_proof || !proof.sub_root_path) return no('MALFORMED_PROOF');
        // Bind to the REQUESTED (contract_index, state_key) when the caller supplies
        // it. Without this a server answers a different key with a valid proof, which
        // is exactly what the explorer's double-decode did. See expectedMismatch.
        if (expectedMismatch(expected, proof)) return no('REQUESTED_IDENTITY_MISMATCH');
        // The proven key must be exactly contractStateKey(chain, network, index, key),
        // with chain/network from the TRUSTED checkpoint rather than the proof: a
        // server must not be able to answer for one key with another key's proof.
        const keyBuf = M.contractStateKey(chain, network, proof.contract_index, proof.state_key);
        if (lowerHex(proof.smt_proof.key) !== M.toHex(keyBuf)) return no('KEY_MISMATCH');

        const leaf = proof.smt_proof.leaf_value;
        const val  = (proof.state_value == null) ? null : String(proof.state_value);
        if (leaf == null){
            if (val !== null) return no('NONINCLUSION_WITH_VALUE');
        } else {
            if (val === null) return no('INCLUSION_WITHOUT_VALUE');
            // Binds the returned value to the committed leaf, so the server's
            // `state_value` cannot lie about what the contract stored.
            if (M.toHex(M.leafHash(val)) !== lowerHex(leaf)) return no('LEAF_VALUE_MISMATCH');
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
        if (!proof || !proof.merkle_proof) return unverified('MALFORMED_PROOF');
        // Recompute the action leaf from the proof's own fields: the server cannot
        // bind a leaf it did not also describe.
        const leaf = M.toHex(M.actionsLeaf({ action_index: proof.action_index,
            tx_index: proof.tx_index, action: (proof.action == null) ? '' : proof.action }));
        if (lowerHex(proof.leaf) !== leaf) return unverified('LEAF_MISMATCH');
        if (!M.verifyFixedMerkleProof(trustedBlockMerkleRoot, M.toBuf(leaf),
                                      proof.merkle_proof.index, proof.merkle_proof.siblings))
            return unverified('MERKLE_PROOF_INVALID');
        return { verified: true, reason: null };
    } catch (e){ return unverified('VERIFY_ERROR:' + (e && e.message)); }
}
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
                if (lowerHex(v.smt_proof && v.smt_proof.leaf_value) !== M.toHex(M.stakeMemberLeaf(v.source, v.weight)))
                    return { verified: false, capabilities: {}, reason: 'MEMBER_LEAF_MISMATCH:' + v.pubkey };
                if (!M.verifyCompressedSmtProof(proof.stakes_root, M.stakeKey(String(v.pubkey), cap), v.smt_proof.leaf_value, v.smt_proof.compressed))
                    return { verified: false, capabilities: {}, reason: 'MEMBER_PROOF_INVALID:' + v.pubkey };
                validators.push({ pubkey: String(v.pubkey), source: String(v.source), weight: String(v.weight) });
            }
            // The committed total S (proven via __total__) is the quorum denominator.
            let total = '0';
            if (c.total_proof){
                if (lowerHex(c.total_proof.leaf_value) !== M.toHex(M.stakeTotalLeaf(c.total)))
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

module.exports = { verifyBalanceProof, verifyLockedBalanceProof, verifyContractStateProof, verifyActionProof, verifyValidatorSetProof };
