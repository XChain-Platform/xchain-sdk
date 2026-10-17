'use strict';

// verifyCheckpointWithProvenSet cross-checks the committed __total__ against the
// proven set's source-deduped sum. The producers commit the exact BigInt sum
// (M.sumCanonicalAmounts); the verifier once used String(bignumber), which is
// exponent notation from 1e21 up, so a valid proven set was rejected.

const assert = require('assert');
const crypto = require('crypto');
const M      = require('../../../../../src/merkle.js');
const light  = require('../../../../../src/protocol/light_client.js');
const checkpoint = require('../../../../../src/checkpoint.js');

function signer() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const spki = publicKey.export({ type: 'spki', format: 'der' });
    return { privateKey, pubkey: spki.subarray(spki.length - 32).toString('hex') };
}
function signedCheckpoint(signers) {
    const cp = { chain: 'BTC', network: 'regtest', block_index: 100, block_hash: 'c0'.repeat(32),
        ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
        checkpoint_seq: 0, snapshot_block: 100, state_root: 'd4'.repeat(32), state_root_version: 1,
        block_merkle_root: 'e5'.repeat(32), block_merkle_version: 1, validator_signatures: [] };
    const canonical = checkpoint.canonicalCheckpoint(cp);
    cp.validator_signatures = signers.map(s => ({ pubkey: s.pubkey, sig: crypto.sign(null, Buffer.from(canonical, 'utf8'), s.privateKey).toString('hex') }));
    return cp;
}

describe('verifyCheckpointWithProvenSet total matches the producer commitment', function () {
    const cases = [
        ['existing small totals are unchanged', ['10', '30'], '40'],
        ['a total of exactly 1e21', ['600000000000000000000', '400000000000000000000'], '1000000000000000000000'],
        ['a total above 1e21 with decimals', ['600000000000000000000.12345678', '400000000000000000000.5'], null],
        ['a 30-digit total', ['123456789012345678901234567890', '100000000000000000000000000000'], null]
    ];
    for (const [name, [a, b], expectInt] of cases) {
        it(name, function () {
            const s1 = signer(), s2 = signer();
            const validators = [{ pubkey: s1.pubkey, source: 'S1', weight: a },
                                { pubkey: s2.pubkey, source: 'S2', weight: b }];
            const committed = M.sumCanonicalAmounts([a, b]);             // indexer / sync commitment
            if (expectInt) assert.strictEqual(committed, M.canonicalAmount(expectInt));
            const r = light.verifyCheckpointWithProvenSet(signedCheckpoint([s1, s2]), { validators, total: committed });
            assert.strictEqual(r.valid, true);
            assert.strictEqual(r.total, committed);
        });
    }

    it('still rejects a committed total that disagrees with the proven set', function () {
        const s1 = signer(), s2 = signer();
        const validators = [{ pubkey: s1.pubkey, source: 'S1', weight: '600000000000000000000' },
                            { pubkey: s2.pubkey, source: 'S2', weight: '400000000000000000000' }];
        const wrong = M.sumCanonicalAmounts(['600000000000000000000', '400000000000000000001']);
        assert.strictEqual(light.verifyCheckpointWithProvenSet(signedCheckpoint([s1, s2]), { validators, total: wrong }).valid, false);
    });
});
