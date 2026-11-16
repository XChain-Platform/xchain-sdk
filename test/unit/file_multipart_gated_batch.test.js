const { expect } = require('chai');
const crypto = require('crypto');
const GatedFileUtils = require('../../src/actions/gated_file.js');
const MessagingUtils = require('../../src/actions/messaging.js');
const WalletUtils = require('../../src/utils/wallet.js');
const {
    keyCommitMessageParams,
    gatedManifestBatchEntries
} = require('../../src/file/multipart_gated_batch.js');

const NETWORK = 'bitcoin-regtest';

function fixture() {
    let wallet = new WalletUtils(NETWORK);
    let source = wallet.generateKeyPair();
    let key = crypto.randomBytes(32);
    let keyHash = crypto.createHash('sha256').update(key).digest('hex');
    return {
        source,
        messaging: new MessagingUtils(NETWORK),
        input: {
            manifestParams: { version: 1, gateTicker: 'TKN', keyHash },
            key,
            coin: 'btc',
            sourceAddress: wallet.deriveAddress(source.publicKey),
            sourcePubkey: source.publicKeyHex
        }
    };
}

function throwsCode(fn, code, field) {
    let thrown;
    try { fn(); } catch (err) { thrown = err; }
    expect(thrown).to.be.instanceOf(Error);
    expect(thrown).to.have.property('code', code);
    expect(thrown.message).to.include(field);
}

describe('multipart gated key commit', function () {
    it('round-trips the key through a self-addressed MESSAGE v2 payload', function () {
        let { source, messaging, input } = fixture();
        let commit = keyCommitMessageParams(input, messaging);
        expect(Object.keys(commit)).to.deep.equal(['coin', 'destination', 'encryptedMessage']);
        expect(commit.coin).to.equal('BTC');
        expect(commit.destination).to.equal(input.sourceAddress);
        expect(commit).not.to.have.property('encryptionMethod');
        let decrypted = messaging.eciesDecryptBytes(commit.encryptedMessage, source.wif).plaintext;
        let keys = new GatedFileUtils().parseKeyPayload(decrypted);
        expect(keys).to.have.length(1);
        expect(keys[0].equals(input.key)).to.equal(true);
    });
});

describe('multipart gated batch entries', function () {
    it('returns exact BatchBuilder entry keys in FILE then MESSAGE order', function () {
        let { messaging, input } = fixture();
        input.manifestParams.keyHash = input.manifestParams.keyHash.toUpperCase();
        let entries = gatedManifestBatchEntries(input, messaging);
        expect(entries.map((entry) => entry.action)).to.deep.equal(['FILE', 'MESSAGE']);
        expect(entries.map((entry) => Object.keys(entry))).to.deep.equal([
            ['action', 'params'], ['action', 'params']
        ]);
        expect(entries[0].params).to.equal(input.manifestParams);
        expect(Object.keys(entries[1].params)).to.deep.equal([
            'coin', 'destination', 'encryptedMessage'
        ]);
    });

    it('allows rawData inherited from a manifest prototype', function () {
        let { messaging, input } = fixture();
        let manifestParams = Object.assign(Object.create({ rawData: Buffer.alloc(1) }),
            input.manifestParams);
        let entries = gatedManifestBatchEntries({ ...input, manifestParams }, messaging);
        expect(entries[0].params).to.equal(manifestParams);
    });
});

describe('multipart gated manifest refusals', function () {
    it('rejects invalid manifest fields and a key mismatch before encryption', function () {
        let { input } = fixture();
        let calls = 0;
        let messaging = { eciesEncryptBytes() { calls += 1; } };
        let cases = [
            [{ ...input.manifestParams, rawData: undefined }, 'GATED_MANIFEST_INVALID', 'rawData'],
            [{ ...input.manifestParams, gateTicker: '' }, 'GATED_MANIFEST_INVALID', 'gateTicker'],
            [
                { ...input.manifestParams, gateTicker: undefined },
                'GATED_MANIFEST_INVALID',
                'gateTicker'
            ],
            [{ ...input.manifestParams, keyHash: 'ab' }, 'GATED_MANIFEST_INVALID', 'keyHash'],
            [
                { ...input.manifestParams, keyHash: 'g'.repeat(64) },
                'GATED_MANIFEST_INVALID',
                'keyHash'
            ],
            [
                { ...input.manifestParams, keyHash: '0'.repeat(64) },
                'GATED_KEY_MISMATCH',
                'keyHash'
            ]
        ];
        for (let [manifestParams, code, field] of cases) {
            let build = () => gatedManifestBatchEntries({ ...input, manifestParams }, messaging);
            throwsCode(build, code, field);
        }
        expect(calls).to.equal(0);
    });
});

describe('multipart gated key commit refusals', function () {
    it('rejects invalid key, coin, address, and public key before encryption', function () {
        let { input } = fixture();
        let calls = 0;
        let messaging = { eciesEncryptBytes() { calls += 1; } };
        let cases = [
            [{ ...input, key: Buffer.alloc(31) }, 'GATED_MANIFEST_INVALID', 'key'],
            [{ ...input, key: 'not-a-buffer' }, 'GATED_MANIFEST_INVALID', 'key'],
            [{ ...input, coin: '' }, 'GATED_MANIFEST_INVALID', 'coin'],
            [{ ...input, coin: undefined }, 'GATED_MANIFEST_INVALID', 'coin'],
            [{ ...input, sourceAddress: '' }, 'GATED_MANIFEST_INVALID', 'sourceAddress'],
            [{ ...input, sourceAddress: undefined }, 'GATED_MANIFEST_INVALID', 'sourceAddress'],
            [{ ...input, sourcePubkey: '02ff' }, 'INVALID_PUBKEY', 'sourcePubkey'],
            [{ ...input, sourcePubkey: `02${'ff'.repeat(32)}` }, 'INVALID_PUBKEY', 'sourcePubkey']
        ];
        for (let [badInput, code, field] of cases)
            throwsCode(() => keyCommitMessageParams(badInput, messaging), code, field);
        expect(calls).to.equal(0);
    });
});
