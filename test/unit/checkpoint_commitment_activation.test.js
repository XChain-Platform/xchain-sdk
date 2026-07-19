//  doctrine test-coverage program: unit coverage for the SDK's copy of
// src/checkpoint_commitment_activation.js (byte-identical twin of the
// hub/indexer/explorer/sync copies). The SDK verifier must gate the SIGNED
// checkpoint preimage on the same BTC-anchored snapshot_block era, so this pins
// the threshold map and the gate function.

const assert = require('assert');
const {
    CHECKPOINT_COMMITMENT_ACTIVATION, isCheckpointCommitmentActive,
} = require('../../src/checkpoint_commitment_activation.js');

describe('checkpoint_commitment_activation', function () {
    it('regtest/testnet are armed from genesis; mainnet is a positive integer', function () {
        assert.strictEqual(CHECKPOINT_COMMITMENT_ACTIVATION.regtest, 0);
        assert.strictEqual(CHECKPOINT_COMMITMENT_ACTIVATION.testnet, 0);
        assert.ok(Number.isSafeInteger(CHECKPOINT_COMMITMENT_ACTIVATION.mainnet));
        assert.ok(CHECKPOINT_COMMITMENT_ACTIVATION.mainnet > 0);
    });

    it('activates at/above the threshold, off below it', function () {
        const t = CHECKPOINT_COMMITMENT_ACTIVATION.mainnet;
        assert.strictEqual(isCheckpointCommitmentActive(t, 'mainnet'), true);
        assert.strictEqual(isCheckpointCommitmentActive(t - 1, 'mainnet'), false);
    });

    it('fails closed on malformed input and unknown networks', function () {
        assert.strictEqual(isCheckpointCommitmentActive('nope', 'mainnet'), false);
        assert.strictEqual(isCheckpointCommitmentActive(10 ** 12, 'no-such-net'), false);
    });
});
