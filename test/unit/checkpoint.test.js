'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

// CheckpointVerifier: canonical-string byte-compat with the hub engine,
// real-Ed25519 quorum verification, tamper detection, and the explorer
// fetch-and-verify path (stubbed fetch; server `verified` flag ignored).

const assert  = require('assert');
const crypto  = require('crypto');
const Checkpoint = require('../../src/checkpoint.js');

// Raw-hex Ed25519 keypair via Node crypto (SPKI/PKCS8 DER stripping mirrors
// ValidatorIdentity's prefixes).
function makeKeypair() {
    let { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    let pubDer = publicKey.export({ format: 'der', type: 'spki' });
    return { pubkeyHex: pubDer.slice(12).toString('hex'), privateKey };
}
function signHex(privateKey, payload) {
    return crypto.sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('hex');
}

function makeCheckpoint(overrides = {}) {
    return Object.assign({
        chain: 'BTC', network: 'mainnet', block_index: 900123,
        block_hash: 'ab'.repeat(32), ledger_hash: 'cd'.repeat(32),
        actions_hash: 'ef'.repeat(32), contract_hash: '01'.repeat(32),
        checkpoint_seq: 417, snapshot_block: 900120
    }, overrides);
}

describe('CheckpointVerifier (SDK)', function () {

    it('canonical string matches the ANCHOR spec byte-for-byte', function () {
        assert.strictEqual(
            Checkpoint.canonicalCheckpoint(makeCheckpoint()),
            'XCHECKPOINT|BTC|mainnet|900123|' + 'ab'.repeat(32) + '|' + 'cd'.repeat(32) +
            '|' + 'ef'.repeat(32) + '|' + '01'.repeat(32) + '|417|900120');
    });

    it('verifies a 2f+1 quorum of real Ed25519 signatures', function () {
        let keys = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
        let cp = makeCheckpoint();
        let canonical = Checkpoint.canonicalCheckpoint(cp);
        // 3 of 4 sign (quorum 2f+1 = 3)
        cp.validator_signatures = JSON.stringify(keys.slice(0, 3).map(k =>
            ({ pubkey: k.pubkeyHex, sig: signHex(k.privateKey, canonical) })));
        let result = Checkpoint.verifyCheckpoint(cp, keys.map(k => k.pubkeyHex));
        assert.strictEqual(result.valid, true);
        assert.strictEqual(result.validSigs, 3);
        assert.strictEqual(result.quorum, 3);
    });

    it('floors quorum at a simple majority: N=3 requires 2, not bare 2f+1=1', function () {
        // Spec (ANCHOR.md): quorum = max(2f+1, ceil((N+1)/2)). At N=3 bare 2f+1
        // is 1, but the floor lifts it to 2. A checkpoint carrying a single
        // Byzantine oracle_publish signature (within the f=1 budget) must NOT
        // verify — the SDK must match the consensus producers, not bare PBFT.
        let keys = [makeKeypair(), makeKeypair(), makeKeypair()];
        let cp = makeCheckpoint();
        let canonical = Checkpoint.canonicalCheckpoint(cp);
        // Only 1 of 3 signs.
        cp.validator_signatures = JSON.stringify([
            { pubkey: keys[0].pubkeyHex, sig: signHex(keys[0].privateKey, canonical) }]);
        let result = Checkpoint.verifyCheckpoint(cp, keys.map(k => k.pubkeyHex));
        assert.strictEqual(result.quorum, 2);                                          // floored, not 1
        assert.strictEqual(result.validSigs, 1);
        assert.strictEqual(result.valid, false);                                       // 1 < quorum 2
    });

    it('rejects below quorum, unknown signers, and duplicated pubkeys', function () {
        let keys = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
        let outsider = makeKeypair();
        let cp = makeCheckpoint();
        let canonical = Checkpoint.canonicalCheckpoint(cp);
        let sig0 = { pubkey: keys[0].pubkeyHex, sig: signHex(keys[0].privateKey, canonical) };
        cp.validator_signatures = JSON.stringify([
            sig0, sig0, sig0,                                                          // duplicates count once
            { pubkey: outsider.pubkeyHex, sig: signHex(outsider.privateKey, canonical) }, // not in the set
            { pubkey: keys[1].pubkeyHex,  sig: signHex(keys[1].privateKey, canonical) }
        ]);
        let result = Checkpoint.verifyCheckpoint(cp, keys.map(k => k.pubkeyHex));
        assert.strictEqual(result.validSigs, 2);
        assert.strictEqual(result.valid, false);                                       // 2 < quorum 3
    });

    it('a tampered field invalidates every signature', function () {
        let key = makeKeypair();
        let cp = makeCheckpoint();
        cp.validator_signatures = JSON.stringify([
            { pubkey: key.pubkeyHex, sig: signHex(key.privateKey, Checkpoint.canonicalCheckpoint(cp)) }]);
        cp.ledger_hash = 'ff'.repeat(32);                                              // tamper after signing
        let result = Checkpoint.verifyCheckpoint(cp, [key.pubkeyHex]);
        assert.strictEqual(result.valid, false);
        assert.strictEqual(result.validSigs, 0);
    });

    it('an empty validator set can never be valid', function () {
        let key = makeKeypair();
        let cp = makeCheckpoint();
        cp.validator_signatures = JSON.stringify([
            { pubkey: key.pubkeyHex, sig: signHex(key.privateKey, Checkpoint.canonicalCheckpoint(cp)) }]);
        assert.strictEqual(Checkpoint.verifyCheckpoint(cp, []).valid, false);
    });

    it('fetchAndVerifyCheckpoint verifies locally and ignores the server verdict', async function () {
        let key = makeKeypair();
        let cp = makeCheckpoint();
        cp.validator_signatures = JSON.stringify([
            { pubkey: key.pubkeyHex, sig: signHex(key.privateKey, Checkpoint.canonicalCheckpoint(cp)) }]);
        let fetchedUrl = null;
        let stubFetch = async (url) => {
            fetchedUrl = url;
            return { ok: true, json: async () => ({
                checkpoint: cp, validators: [key.pubkeyHex],
                verified: false,                                                       // lying server — must be ignored
                snapshot_available: true
            }) };
        };
        let result = await Checkpoint.fetchAndVerifyCheckpoint('https://explorer.xchain.io/', 'BTC', 900123, stubFetch);
        assert.strictEqual(fetchedUrl, 'https://explorer.xchain.io/BTC/api/checkpoint/900123/verify');
        assert.strictEqual(result.valid, true);                                        // local crypto decides
        assert.strictEqual(result.snapshotAvailable, true);
    });
});

// Stake-weighted regime (STAKE_WEIGHTED_QUORUM / WI-1). On a network where the
// flag-day is active (regtest activation = 0) the SDK must apply the same
// source-deduped 3·Σ > 2·S predicate the hub finalizes on, NOT the count 2f+1 —
// otherwise it false-rejects a stake-heavy minority the federation anchored, and
// unsafe-accepts a key-count majority that lacks stake majority.
describe('CheckpointVerifier — stake-weighted quorum (SDK)', function () {

    // Each key of a source carries the SAME source + weight (DELEGATE v0 additive,
    // source-deduped) — mirrors the hub/indexer snapshot shape.
    function vset(entries) {
        let out = [];
        for (let e of entries)
            for (let k of e.keys)
                out.push({ pubkey: k.pubkeyHex, source: e.source, weight: String(e.weight) });
        return out;
    }
    function signAll(keys, canonical) {
        return JSON.stringify(keys.map(k => ({ pubkey: k.pubkeyHex, sig: signHex(k.privateKey, canonical) })));
    }

    it('weighted PASS: a single-source stake-heavy minority (>2/3 stake, below count) verifies', function () {
        // 4 distinct sources; A holds 70 of 100 stake. Only A's one key signs.
        let A = makeKeypair(), B = makeKeypair(), C = makeKeypair(), D = makeKeypair();
        let cp = makeCheckpoint({ network: 'regtest' });
        let canonical = Checkpoint.canonicalCheckpoint(cp);
        let validators = vset([
            { source: 'srcA', weight: 70, keys: [A] },
            { source: 'srcB', weight: 10, keys: [B] },
            { source: 'srcC', weight: 10, keys: [C] },
            { source: 'srcD', weight: 10, keys: [D] }
        ]);
        cp.validator_signatures = signAll([A], canonical);                              // 1 sig only
        let result = Checkpoint.verifyCheckpoint(cp, validators);
        assert.strictEqual(result.weighted, true);
        assert.strictEqual(result.validSigs, 1);
        assert.ok(result.validSigs < result.quorum, 'below the count threshold');       // 1 < 3
        assert.strictEqual(result.valid, true);                                         // 3·70 > 2·100
    });

    it('weighted FAIL: a key-count majority lacking stake majority does NOT verify', function () {
        // Source A has 3 keys but only 5 stake; source B has 1 key with 95 stake.
        // A's three keys are a count majority (3 of 4 keys) but a stake minority.
        let A1 = makeKeypair(), A2 = makeKeypair(), A3 = makeKeypair(), B = makeKeypair();
        let cp = makeCheckpoint({ network: 'regtest' });
        let canonical = Checkpoint.canonicalCheckpoint(cp);
        let validators = vset([
            { source: 'srcA', weight: 5,  keys: [A1, A2, A3] },
            { source: 'srcB', weight: 95, keys: [B] }
        ]);
        cp.validator_signatures = signAll([A1, A2, A3], canonical);                     // count majority
        let result = Checkpoint.verifyCheckpoint(cp, validators);
        assert.strictEqual(result.weighted, true);
        assert.strictEqual(result.validSigs, 3);
        assert.ok(result.validSigs >= result.quorum, 'would pass the count threshold');  // 3 >= 3
        assert.strictEqual(result.valid, false);                                        // 3·5 ≯ 2·100
    });

    it('weighted regime fails closed when the set carries no weight/source', function () {
        // An un-upgraded explorer (or a legacy bare-pubkey list) cannot prove stake
        // quorum once weighting is active — the SDK must refuse, not silently count.
        let A = makeKeypair(), B = makeKeypair(), C = makeKeypair();
        let cp = makeCheckpoint({ network: 'regtest' });
        let canonical = Checkpoint.canonicalCheckpoint(cp);
        cp.validator_signatures = signAll([A, B, C], canonical);
        let result = Checkpoint.verifyCheckpoint(cp, [A.pubkeyHex, B.pubkeyHex, C.pubkeyHex]);
        assert.strictEqual(result.weighted, true);
        assert.strictEqual(result.valid, false);
    });

    it('below the flag-day (mainnet) the count path is unchanged: weighted=false', function () {
        let keys = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
        let cp = makeCheckpoint();                                                      // mainnet, inactive
        let canonical = Checkpoint.canonicalCheckpoint(cp);
        cp.validator_signatures = signAll(keys.slice(0, 3), canonical);
        let result = Checkpoint.verifyCheckpoint(cp, keys.map(k => k.pubkeyHex));
        assert.strictEqual(result.weighted, false);
        assert.strictEqual(result.valid, true);                                         // count 3 >= quorum 3
    });
});
