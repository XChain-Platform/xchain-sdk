/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain SDK - State Checkpoint Verifier
 *
 * Client-side verification of quorum-signed state checkpoints — the
 * light-client primitive that lets a wallet or application verify an
 * indexer/explorer's state against `2f+1` `oracle_publish` validator
 * signatures instead of trusting any single operator. Verification is
 * pure local crypto (Node built-in Ed25519): nothing here trusts the
 * server's own `verified` flag.
 *
 * Spec: xchain-documentation/protocol/actions/ANCHOR.md
 *
 ********************************************************************/

const crypto = require('crypto');

// ASN.1 DER prefix for Ed25519 SPKI — mirrors the hub's ValidatorIdentity and
// the indexer's ed25519.js, so validator signatures verify identically here.
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

// Build the canonical signing string for a checkpoint object — MUST stay
// byte-identical to the hub's StateCheckpointEngine.canonicalCheckpoint and
// the indexer's ANCHOR verifier:
//   XCHECKPOINT|CHAIN|NETWORK|BLOCK_INDEX|BLOCK_HASH|LEDGER_HASH|ACTIONS_HASH|CONTRACT_HASH|CHECKPOINT_SEQ|SNAPSHOT_BLOCK
function canonicalCheckpoint(cp){
    if (!cp) throw new Error('CheckpointVerifier: checkpoint object required');
    return ['XCHECKPOINT', cp.chain, cp.network, String(cp.block_index), cp.block_hash,
            cp.ledger_hash, cp.actions_hash, cp.contract_hash,
            String(cp.checkpoint_seq), String(cp.snapshot_block)].join('|');
}

// Verify one Ed25519 signature over a UTF-8 payload (never throws).
function verifySignature(payload, sigHex, pubkeyHex){
    if (!payload || !sigHex || !pubkeyHex) return false;
    if (!/^[0-9a-fA-F]{64}$/.test(pubkeyHex)) return false;
    if (!/^[0-9a-fA-F]{128}$/.test(sigHex)) return false;
    try {
        let spkiDer = Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(pubkeyHex, 'hex')]);
        let pubkeyObj = crypto.createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
        return crypto.verify(null, Buffer.from(payload, 'utf8'), pubkeyObj, Buffer.from(sigHex, 'hex'));
    } catch (e) {
        return false;
    }
}

// Verify a checkpoint against a qualifying validator set.
//   checkpoint — { chain, network, block_index, block_hash, ledger_hash,
//                  actions_hash, contract_hash, checkpoint_seq, snapshot_block,
//                  validator_signatures } (signatures as a JSON string or array)
//   validators — array of 64-hex `oracle_publish` pubkeys qualified at the
//                checkpoint's snapshot_block (e.g. the explorer verify
//                endpoint's `validators`, or an independently fetched set)
// Returns { valid, validSigs, quorum, canonical } — valid means validSigs
// reached 2f+1 of the supplied set. Pure local verification.
function verifyCheckpoint(checkpoint, validators){
    let canonical = canonicalCheckpoint(checkpoint);
    let qualified = new Set((validators || []).map(p => String(p && p.pubkey !== undefined ? p.pubkey : p).toLowerCase()));
    let quorum    = (qualified.size <= 1) ? 1 : (2 * Math.floor((qualified.size - 1) / 3) + 1);

    let sigs = checkpoint.validator_signatures;
    if (typeof sigs === 'string'){
        try { sigs = JSON.parse(sigs); } catch (e) { sigs = []; }
    }
    if (!Array.isArray(sigs)) sigs = [];

    let validSigs = 0, seen = new Set();
    for (let s of sigs){
        let pk  = String(s && s.pubkey || '').toLowerCase();
        let sig = String(s && s.sig || '');
        if (!pk || seen.has(pk) || !qualified.has(pk)) continue;
        seen.add(pk);
        if (verifySignature(canonical, sig, pk)) validSigs++;
    }
    return {
        valid:     qualified.size > 0 && validSigs >= quorum,
        validSigs: validSigs,
        quorum:    quorum,
        canonical: canonical
    };
}

// Convenience: fetch a checkpoint (+ the qualifying validator set) from an
// explorer's verify endpoint and re-verify LOCALLY — the server's `verified`
// flag is ignored; only local crypto decides.
//   explorerUrl — e.g. 'https://explorer.xchain.io'
//   coin        — explorer coin code (e.g. 'BTC', 'TBTC', 'RDOGE')
//   blockIndex  — checkpointed height
async function fetchAndVerifyCheckpoint(explorerUrl, coin, blockIndex, fetchImpl){
    let f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!f) throw new Error('CheckpointVerifier: no fetch implementation available');
    let base = String(explorerUrl || '').replace(/\/+$/, '');
    let url  = base + '/' + encodeURIComponent(String(coin)) + '/api/checkpoint/' +
               encodeURIComponent(String(blockIndex)) + '/verify';
    let res  = await f(url);
    if (!res.ok) throw new Error('CheckpointVerifier: explorer returned HTTP ' + res.status);
    let body = await res.json();
    if (!body || !body.checkpoint) throw new Error('CheckpointVerifier: no checkpoint in response');
    let result = verifyCheckpoint(body.checkpoint, body.validators || []);
    return Object.assign({ checkpoint: body.checkpoint, snapshotAvailable: !!body.snapshot_available }, result);
}

module.exports = {
    canonicalCheckpoint,
    verifySignature,
    verifyCheckpoint,
    fetchAndVerifyCheckpoint
};
