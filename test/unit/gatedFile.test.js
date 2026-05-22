const { expect } = require('chai');
const GatedFileUtils = require('../../src/gatedFile.js');
const { HANDOFF_TYPE, KEY_LEN, IV_LEN, AUTH_TAG_LEN } = require('../../src/gatedFile.js');
const { SDKGatedFileError } = require('../../src/errors.js');

describe('GatedFileUtils', function () {

    let g;
    beforeEach(function () { g = new GatedFileUtils(); });

    describe('generateKey', function () {
        it('returns a 32-byte Buffer and matching hex hash', function () {
            let { key, keyHash } = g.generateKey();
            expect(Buffer.isBuffer(key)).to.equal(true);
            expect(key.length).to.equal(KEY_LEN);
            expect(keyHash).to.match(/^[0-9a-f]{64}$/);
        });

        it('produces distinct keys on each call', function () {
            let a = g.generateKey();
            let b = g.generateKey();
            expect(a.key.equals(b.key)).to.equal(false);
            expect(a.keyHash).to.not.equal(b.keyHash);
        });
    });

    describe('encryptFileBytes / decryptFileBytes round-trip', function () {
        it('round-trips a Buffer plaintext', function () {
            let plaintext = Buffer.from('hello gated world', 'utf8');
            let { ciphertext, key, keyHash } = g.encryptFileBytes(plaintext);
            expect(Buffer.isBuffer(ciphertext)).to.equal(true);
            expect(ciphertext.length).to.equal(IV_LEN + AUTH_TAG_LEN + plaintext.length);
            expect(g.verifyKey(key, keyHash)).to.equal(true);

            let decrypted = g.decryptFileBytes(ciphertext, key);
            expect(decrypted.equals(plaintext)).to.equal(true);
        });

        it('round-trips a string plaintext (treated as utf8)', function () {
            let plaintext = 'tokens unlock content';
            let { ciphertext, key } = g.encryptFileBytes(plaintext);
            let decrypted = g.decryptFileBytes(ciphertext, key);
            expect(decrypted.toString('utf8')).to.equal(plaintext);
        });

        it('round-trips binary file bytes', function () {
            let plaintext = Buffer.from([0x00, 0xff, 0x42, 0x10, 0x99, 0xaa, 0xbb]);
            let { ciphertext, key } = g.encryptFileBytes(plaintext);
            let decrypted = g.decryptFileBytes(ciphertext, key);
            expect(decrypted.equals(plaintext)).to.equal(true);
        });
    });

    describe('encryptPack', function () {
        it('encrypts N plaintexts under one shared key', function () {
            let inputs = [
                Buffer.from('track-01 audio bytes'),
                Buffer.from('track-02 audio bytes'),
                Buffer.from('liner notes pdf bytes')
            ];
            let { ciphertexts, key, keyHash } = g.encryptPack(inputs);
            expect(ciphertexts).to.have.lengthOf(3);
            expect(g.verifyKey(key, keyHash)).to.equal(true);

            for (let i = 0; i < inputs.length; i++) {
                let decrypted = g.decryptFileBytes(ciphertexts[i], key);
                expect(decrypted.equals(inputs[i])).to.equal(true);
            }
        });

        it('uses a distinct nonce per pack member', function () {
            let inputs = [Buffer.from('same'), Buffer.from('same'), Buffer.from('same')];
            let { ciphertexts } = g.encryptPack(inputs);
            let ivs = ciphertexts.map((c) => c.slice(0, IV_LEN).toString('hex'));
            // All three ivs should differ; even though plaintext + key are identical
            expect(new Set(ivs).size).to.equal(3);
        });

        it('throws on empty plaintext array', function () {
            expect(() => g.encryptPack([])).to.throw(SDKGatedFileError);
        });

        it('handles a single-element array (degenerate pack)', function () {
            let { ciphertexts, key } = g.encryptPack([Buffer.from('only one')]);
            expect(ciphertexts).to.have.lengthOf(1);
            expect(g.decryptFileBytes(ciphertexts[0], key).toString()).to.equal('only one');
        });
    });

    describe('verifyKey', function () {
        it('returns true for matching key + hash', function () {
            let { key, keyHash } = g.generateKey();
            expect(g.verifyKey(key, keyHash)).to.equal(true);
        });

        it('returns false for wrong key', function () {
            let { keyHash } = g.generateKey();
            let { key: otherKey } = g.generateKey();
            expect(g.verifyKey(otherKey, keyHash)).to.equal(false);
        });

        it('returns false for bad key types', function () {
            let { keyHash } = g.generateKey();
            expect(g.verifyKey(null, keyHash)).to.equal(false);
            expect(g.verifyKey(Buffer.alloc(16), keyHash)).to.equal(false);
        });
    });

    describe('decryptFileBytes — negative paths', function () {
        it('throws on wrong key (GCM auth fail)', function () {
            let { ciphertext } = g.encryptFileBytes('secret');
            let { key: wrongKey } = g.generateKey();
            expect(() => g.decryptFileBytes(ciphertext, wrongKey))
                .to.throw(SDKGatedFileError)
                .with.property('code', 'DECRYPT_FAILED');
        });

        it('throws on tampered ciphertext byte', function () {
            let { ciphertext, key } = g.encryptFileBytes('secret');
            // Flip a bit inside the encrypted region
            let tampered = Buffer.from(ciphertext);
            tampered[tampered.length - 1] ^= 0x01;
            expect(() => g.decryptFileBytes(tampered, key))
                .to.throw(SDKGatedFileError)
                .with.property('code', 'DECRYPT_FAILED');
        });

        it('throws on tampered authTag', function () {
            let { ciphertext, key } = g.encryptFileBytes('secret');
            let tampered = Buffer.from(ciphertext);
            tampered[IV_LEN] ^= 0x01;
            expect(() => g.decryptFileBytes(tampered, key))
                .to.throw(SDKGatedFileError)
                .with.property('code', 'DECRYPT_FAILED');
        });

        it('throws on too-short ciphertext', function () {
            let { key } = g.generateKey();
            expect(() => g.decryptFileBytes(Buffer.alloc(5), key))
                .to.throw(SDKGatedFileError)
                .with.property('code', 'INVALID_CIPHERTEXT');
        });
    });

    describe('serializeKeyPayload / parseKeyPayload', function () {
        it('round-trips a single-key payload', function () {
            let { key, keyHash } = g.generateKey();
            let json = g.serializeKeyPayload({ [keyHash]: key });
            let parsed = g.parseKeyPayload(json);
            expect(Object.keys(parsed)).to.deep.equal([keyHash]);
            expect(parsed[keyHash].equals(key)).to.equal(true);
        });

        it('round-trips a multi-key payload (multiple gated files/packs)', function () {
            let a = g.generateKey();
            let b = g.generateKey();
            let json = g.serializeKeyPayload({
                [a.keyHash]: a.key,
                [b.keyHash]: b.key
            });
            let parsed = g.parseKeyPayload(json);
            expect(Object.keys(parsed).sort()).to.deep.equal([a.keyHash, b.keyHash].sort());
            expect(parsed[a.keyHash].equals(a.key)).to.equal(true);
            expect(parsed[b.keyHash].equals(b.key)).to.equal(true);
        });

        it('produces canonical JSON shape with HANDOFF_TYPE', function () {
            let { key, keyHash } = g.generateKey();
            let json = g.serializeKeyPayload({ [keyHash]: key });
            let parsed = JSON.parse(json);
            expect(parsed.type).to.equal(HANDOFF_TYPE);
            expect(parsed.keys).to.be.an('object');
            expect(parsed.keys[keyHash]).to.be.a('string');
        });

        it('throws when payload has wrong type', function () {
            let bogus = JSON.stringify({ type: 'something.else', keys: {} });
            expect(() => g.parseKeyPayload(bogus))
                .to.throw(SDKGatedFileError)
                .with.property('code', 'INVALID_PAYLOAD');
        });

        it('throws when payload is not valid JSON', function () {
            expect(() => g.parseKeyPayload('{not json'))
                .to.throw(SDKGatedFileError)
                .with.property('code', 'INVALID_PAYLOAD');
        });

        it('throws when keys map contains a wrong-length key', function () {
            let bogus = JSON.stringify({
                type: HANDOFF_TYPE,
                keys: { 'abcd': Buffer.alloc(8).toString('base64') }
            });
            expect(() => g.parseKeyPayload(bogus))
                .to.throw(SDKGatedFileError)
                .with.property('code', 'INVALID_PAYLOAD');
        });
    });

    describe('pack end-to-end flow', function () {
        it('encrypt → serialize → parse → decrypt all members from one key entry', function () {
            // Issuer side
            let plaintexts = [
                Buffer.from('file-1 plaintext'),
                Buffer.from('file-2 plaintext'),
                Buffer.from('file-3 plaintext')
            ];
            let { ciphertexts, key, keyHash } = g.encryptPack(plaintexts);
            let json = g.serializeKeyPayload({ [keyHash]: key });

            // (Wire would ECIES-encrypt json into a MESSAGE)

            // Holder side — receives MESSAGE, decrypts, parses payload
            let parsed = g.parseKeyPayload(json);
            let recoveredKey = parsed[keyHash];
            expect(g.verifyKey(recoveredKey, keyHash)).to.equal(true);

            // Holder unlocks every pack member with the single recovered key
            for (let i = 0; i < plaintexts.length; i++) {
                let decrypted = g.decryptFileBytes(ciphertexts[i], recoveredKey);
                expect(decrypted.equals(plaintexts[i])).to.equal(true);
            }
        });
    });
});
