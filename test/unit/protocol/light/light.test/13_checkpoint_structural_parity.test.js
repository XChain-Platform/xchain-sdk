'use strict';

const assert = require('assert');
const crypto = require('crypto');
const checkpoint = require('../../../../../src/checkpoint.js');
const follow = require('../../../../../src/protocol/light_client/validator_set_follow.js');

function signer() {
    const pair = crypto.generateKeyPairSync('ed25519');
    const der = pair.publicKey.export({ format: 'der', type: 'spki' });
    return { privateKey: pair.privateKey, pubkey: der.subarray(der.length - 32).toString('hex') };
}

function signedCheckpoint(key, network, snapshotBlock, overrides) {
    const cp = Object.assign({
        chain: 'BTC', network, block_index: snapshotBlock + 6,
        block_hash: '11'.repeat(32), ledger_hash: '22'.repeat(32),
        actions_hash: '33'.repeat(32), contract_hash: '44'.repeat(32),
        checkpoint_seq: 7, snapshot_block: snapshotBlock,
        state_root: '55'.repeat(32), state_root_version: 1,
        block_merkle_root: '66'.repeat(32), block_merkle_version: 1,
        validator_signatures: []
    }, overrides || {});
    const canonical = checkpoint.canonicalCheckpoint(cp);
    cp.validator_signatures = [{ pubkey: key.pubkey,
        sig: crypto.sign(null, Buffer.from(canonical), key.privateKey).toString('hex') }];
    return cp;
}

function proven(key) {
    return { validators: [{ pubkey: key.pubkey, source: 'source-1', weight: '10' }], total: '10' };
}

describe('checkpoint verifier structural parity @regression', function () {
    it('refuses unsigned supersession fields below their activation gate', function () {
        const key = signer();
        const cp = signedCheckpoint(key, 'testnet', 146000);
        const canonical = checkpoint.canonicalCheckpoint(cp);
        assert.strictEqual(follow.verifyCheckpointWithProvenSet(cp, proven(key)).valid, true);

        cp.supersedes_from = 3;
        cp.rules_digest = 'ab'.repeat(32);
        assert.strictEqual(checkpoint.canonicalCheckpoint(cp), canonical);
        assert.strictEqual(checkpoint.supersessionDisallowed(cp), true);
        assert.strictEqual(follow.verifyCheckpointWithProvenSet(cp, proven(key)).valid, false);
        assert.strictEqual(checkpoint.verifyCheckpoint(cp, proven(key).validators).valid, false);
    });

    it('returns invalid instead of throwing for malformed active supersession fields', function () {
        const key = signer();
        const cp = signedCheckpoint(key, 'regtest', 100);
        cp.supersedes_from = 3;
        assert.strictEqual(checkpoint.tryCanonicalCheckpoint(cp), null);
        assert.strictEqual(follow.verifyCheckpointWithProvenSet(cp, proven(key)).valid, false);
        const result = checkpoint.verifyCheckpoint(cp, proven(key).validators);
        assert.strictEqual(result.valid, false);
        assert.strictEqual(result.canonical, null);
    });

    it('rejects a malformed served checkpoint after a forward walk', async function () {
        const followPath = require.resolve('../../../../../src/protocol/light_client/validator_set_follow.js');
        const quorumPath = require.resolve('../../../../../src/protocol/light_client/quorum_resolution.js');
        const original = require(followPath).followForward;
        const trusted = signedCheckpoint(signer(), 'regtest', 104, { block_index: 110 });
        require(followPath).followForward = async () => ({ trusted });
        delete require.cache[quorumPath];
        const { resolveQuorum } = require(quorumPath);
        const served = Object.assign({}, trusted, { supersedes_from: 3 });
        const launch = signer();
        try {
            const result = await resolveQuorum(async () => { throw new Error('unexpected fetch'); }, {
                explorerUrl: 'unused', coin: 'RBTC',
                pinnedResolver: () => ({
                    checkpoint: Object.assign({}, trusted, { block_index: 100 }),
                    validators: [{ pubkey: launch.pubkey, source: 'launch', weight: '10' }]
                })
            }, served);
            assert.strictEqual(result.valid, false);
        } finally {
            require(followPath).followForward = original;
            delete require.cache[quorumPath];
        }
    });
});
