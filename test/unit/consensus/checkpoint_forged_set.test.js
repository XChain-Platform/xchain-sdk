'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// fetchAndVerifyCheckpoint and the pooled sdk.verifyCheckpoint judge the
// checkpoint against the explorer's own validator set unless the caller
// supplies one, and say which set decided the verdict.

const assert  = require('assert');
const crypto  = require('crypto');
const Checkpoint = require('../../../src/checkpoint.js');

// Raw-hex Ed25519 keypair via Node crypto (SPKI DER prefix stripped).
function makeKeypair() {
    let { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    let pubDer = publicKey.export({ format: 'der', type: 'spki' });
    return { pubkeyHex: pubDer.slice(12).toString('hex'), privateKey };
}
function signHex(privateKey, payload) {
    return crypto.sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('hex');
}
// A mainnet checkpoint, where the count quorum applies and no roots are required.
function makeCheckpoint() {
    return { chain: 'BTC', network: 'mainnet', block_index: 900123,
        block_hash: 'ab'.repeat(32), ledger_hash: 'cd'.repeat(32),
        actions_hash: 'ef'.repeat(32), contract_hash: '01'.repeat(32),
        checkpoint_seq: 417, snapshot_block: 900120 };
}

// A dishonest explorer serves a checkpoint signed by its own key together with
// a validator set naming only that key.
describe('CheckpointVerifier (SDK): a forged validator set', function () {
    let honest, attacker, cp, stubFetch;
    beforeEach(function () {
        honest = makeKeypair(); attacker = makeKeypair(); cp = makeCheckpoint();
        cp.validator_signatures = JSON.stringify([
            { pubkey: attacker.pubkeyHex, sig: signHex(attacker.privateKey, Checkpoint.canonicalCheckpoint(cp)) }]);
        stubFetch = async () => ({ ok: true, json: async () => ({ checkpoint: cp, validators: [attacker.pubkeyHex] }) });
    });

    function fetchVerify(opts) {
        return Checkpoint.fetchAndVerifyCheckpoint('https://x', 'BTC', 1, stubFetch, opts);
    }

    it('passes against the served set and says the explorer chose the set', async function () {
        const r = await fetchVerify();
        assert.strictEqual(r.valid, true);
        assert.strictEqual(r.validatorSource, 'explorer');
    });

    it('fails against a supplied honest set, which replaces the served one', async function () {
        const r = await fetchVerify({ validators: [honest.pubkeyHex] });
        assert.strictEqual(r.valid, false);
        assert.strictEqual(r.validatorSource, 'supplied');
    });

    it('treats a supplied empty set as supplied and never falls back to the served set', async function () {
        const r = await fetchVerify({ validators: [] });
        assert.strictEqual(r.valid, false);
        assert.strictEqual(r.validatorSource, 'supplied');
    });

    it('the pooled sdk.verifyCheckpoint honours a supplied set the same way', async function () {
        const queries = require('../../../src/XChainSDK/explorer_network_queries.js');
        const host = { requireExplorer: () => ({ getCheckpointVerify: async () => ({ checkpoint: cp, validators: [attacker.pubkeyHex] }) }) };
        const served = await queries.verifyCheckpoint.call(host, 1);
        assert.strictEqual(served.valid, true);
        assert.strictEqual(served.validatorSource, 'explorer');
        const pinned = await queries.verifyCheckpoint.call(host, 1, { validators: [honest.pubkeyHex] });
        assert.strictEqual(pinned.valid, false);
        assert.strictEqual(pinned.validatorSource, 'supplied');
    });

    it('refuses a non-array validators option before fetching', async function () {
        let fetched = false;
        stubFetch = async () => { fetched = true; return { ok: true, json: async () => ({ checkpoint: cp }) }; };
        await assert.rejects(fetchVerify({ validators: 'nope' }), TypeError);
        assert.strictEqual(fetched, false);
    });
});
