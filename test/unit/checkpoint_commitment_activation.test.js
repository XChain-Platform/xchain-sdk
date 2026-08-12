// Unit coverage for the SDK's copy of src/checkpoint_commitment_activation.js
// (byte-identical twin of the hub/indexer/explorer/sync copies). The SDK
// verifier must gate the SIGNED checkpoint preimage on the same BTC-anchored
// snapshot_block era, so this pins the threshold map and the gate function.

const assert = require('assert');
const {
    CHECKPOINT_COMMITMENT_ACTIVATION, isCheckpointCommitmentActive,
} = require('../../src/checkpoint_commitment_activation.js');

describe('checkpoint_commitment_activation', function () {
    it('regtest is armed from genesis; testnet and mainnet are pinned flag-days', function () {
        assert.strictEqual(CHECKPOINT_COMMITMENT_ACTIVATION.regtest, 0);
        // testnet was 0, which made the hub commit the SPV root suffix from
        // testnet genesis before the indexer had roots to sign, so it refused
        // to sign every testnet checkpoint. Now armed at the first BTC-testnet
        // anchor past all three STATE_COMMITMENT testnet thresholds.
        assert.strictEqual(CHECKPOINT_COMMITMENT_ACTIVATION.testnet, 146000);
        // Pin the exact ARMED mainnet flag-day (BTC anchor ~2026-08-04). A loose
        // `> 0` let a one-sided edit of any vendored copy pass green while moving
        // the block at which every validator starts committing the light-client
        // roots into the signed checkpoint.
        assert.strictEqual(CHECKPOINT_COMMITMENT_ACTIVATION.mainnet, 961000);
    });

    it('activates at/above the threshold, off below it (mainnet)', function () {
        const t = CHECKPOINT_COMMITMENT_ACTIVATION.mainnet;
        assert.strictEqual(isCheckpointCommitmentActive(t, 'mainnet'), true);
        assert.strictEqual(isCheckpointCommitmentActive(t - 1, 'mainnet'), false);
    });

    it('testnet arms at 146000, off one block below', function () {
        assert.strictEqual(isCheckpointCommitmentActive(146000, 'testnet'), true);
        assert.strictEqual(isCheckpointCommitmentActive(145999, 'testnet'), false);
    });

    it('fails closed on malformed input and unknown networks', function () {
        assert.strictEqual(isCheckpointCommitmentActive('nope', 'mainnet'), false);
        assert.strictEqual(isCheckpointCommitmentActive(10 ** 12, 'no-such-net'), false);
    });
});
