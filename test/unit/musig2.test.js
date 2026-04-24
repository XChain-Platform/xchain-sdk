const { expect } = require('chai');
const crypto = require('crypto');
const MuSig2 = require('../../src/musig2.js');
const { secp256k1, schnorr } = require('@noble/curves/secp256k1');


// Convert hex helper
const h = (s) => Buffer.from(s, 'hex');
const toHex = (b) => Buffer.from(b).toString('hex');


describe('MuSig2', function () {

    let musig;

    beforeEach(function () {
        musig = new MuSig2();
    });

    /*
     *  Structure / input validation
     */

    describe('input validation', function () {
        it('aggregateKeys throws when given fewer than 2 pubkeys', function () {
            expect(() => musig.aggregateKeys([])).to.throw(/at least 2/);
            expect(() => musig.aggregateKeys([h('02'.padEnd(66, '0'))])).to.throw(/at least 2/);
        });

        it('aggregateKeys throws on non-array input', function () {
            expect(() => musig.aggregateKeys('not an array')).to.throw(/must be an array/);
        });

        it('aggregateKeys throws on bad pubkey element', function () {
            expect(() => musig.aggregateKeys([h('02'.padEnd(66, '0')), 12345])).to.throw(/hex string or Uint8Array/);
        });

        it('generateNonce rejects params that are not objects', function () {
            expect(() => musig.generateNonce(null)).to.throw(/params required/);
        });

        it('generateNonce rejects mis-sized publicKey', function () {
            expect(() => musig.generateNonce({ publicKey: h('ab') })).to.throw(/publicKey must be 33 bytes/);
        });

        it('generateNonce rejects mis-sized msg', function () {
            const sk = crypto.randomBytes(32);
            const pk = secp256k1.getPublicKey(sk, true);
            expect(() => musig.generateNonce({ publicKey: pk, msg: h('ab') })).to.throw(/msg must be 32 bytes/);
        });

        it('aggregateNonces rejects wrong-size nonces', function () {
            expect(() => musig.aggregateNonces([h('ab'), h('cd')])).to.throw(/must be 66 bytes/);
        });

        it('partialSign rejects missing sessionKey', function () {
            const sk = crypto.randomBytes(32);
            expect(() => musig.partialSign({ secretKey: sk, publicNonce: new Uint8Array(66) }))
                .to.throw(/sessionKey required/);
        });

        it('aggregateSignatures rejects wrong-size partial sigs', function () {
            expect(() => musig.aggregateSignatures([h('ab'), h('cd')], {})).to.throw(/must be 32 bytes/);
        });
    });

    /*
     *  2-of-2 roundtrip: the core assertion that the aggregated
     *  signature verifies under BIP340 Schnorr against the aggregated
     *  x-only pubkey (this is what makes MuSig2 on-chain invisible).
     */

    describe('2-of-2 roundtrip', function () {
        it('aggregated signature verifies as BIP340 Schnorr', function () {
            const sk1 = crypto.randomBytes(32);
            const sk2 = crypto.randomBytes(32);
            const pk1 = secp256k1.getPublicKey(sk1, true);
            const pk2 = secp256k1.getPublicKey(sk2, true);

            const ctx = musig.aggregateKeys([pk1, pk2]);
            expect(ctx.xOnlyPubkey).to.be.instanceOf(Uint8Array);
            expect(ctx.xOnlyPubkey.length).to.equal(32);

            const msg = crypto.randomBytes(32);
            const n1 = musig.generateNonce({ publicKey: pk1, secretKey: sk1, msg, xOnlyPublicKey: ctx.xOnlyPubkey });
            const n2 = musig.generateNonce({ publicKey: pk2, secretKey: sk2, msg, xOnlyPublicKey: ctx.xOnlyPubkey });
            expect(n1.length).to.equal(66);
            expect(n2.length).to.equal(66);

            const aggNonce = musig.aggregateNonces([n1, n2]);
            expect(aggNonce.length).to.equal(66);

            const session = musig.startSession(aggNonce, msg, [pk1, pk2]);

            const s1 = musig.partialSign({ secretKey: sk1, publicNonce: n1, sessionKey: session });
            const s2 = musig.partialSign({ secretKey: sk2, publicNonce: n2, sessionKey: session });
            expect(s1.length).to.equal(32);
            expect(s2.length).to.equal(32);

            const sig = musig.aggregateSignatures([s1, s2], session);
            expect(sig.length).to.equal(64);

            expect(schnorr.verify(sig, msg, ctx.xOnlyPubkey)).to.equal(true);
        });
    });

    /*
     *  3-of-3 roundtrip: same but with one more signer, proving the
     *  path scales beyond the 2-signer base case.
     */

    describe('3-of-3 roundtrip', function () {
        it('aggregated signature verifies', function () {
            const sks = [crypto.randomBytes(32), crypto.randomBytes(32), crypto.randomBytes(32)];
            const pks = sks.map((sk) => secp256k1.getPublicKey(sk, true));

            const ctx = musig.aggregateKeys(pks);
            const msg = crypto.randomBytes(32);
            const nonces = sks.map((sk, i) =>
                musig.generateNonce({ publicKey: pks[i], secretKey: sk, msg, xOnlyPublicKey: ctx.xOnlyPubkey }));
            const aggNonce = musig.aggregateNonces(nonces);
            const session = musig.startSession(aggNonce, msg, pks);
            const partials = sks.map((sk, i) =>
                musig.partialSign({ secretKey: sk, publicNonce: nonces[i], sessionKey: session }));
            const sig = musig.aggregateSignatures(partials, session);

            expect(schnorr.verify(sig, msg, ctx.xOnlyPubkey)).to.equal(true);
        });
    });

    /*
     *  Partial-sig verify + tamper detection.
     */

    describe('partial sig verification', function () {
        it('verifyPartial accepts a valid partial signature', function () {
            const sk1 = crypto.randomBytes(32);
            const sk2 = crypto.randomBytes(32);
            const pk1 = secp256k1.getPublicKey(sk1, true);
            const pk2 = secp256k1.getPublicKey(sk2, true);
            const ctx = musig.aggregateKeys([pk1, pk2]);
            const msg = crypto.randomBytes(32);
            const n1 = musig.generateNonce({ publicKey: pk1, secretKey: sk1, msg, xOnlyPublicKey: ctx.xOnlyPubkey });
            const n2 = musig.generateNonce({ publicKey: pk2, secretKey: sk2, msg, xOnlyPublicKey: ctx.xOnlyPubkey });
            const aggNonce = musig.aggregateNonces([n1, n2]);
            const session = musig.startSession(aggNonce, msg, [pk1, pk2]);
            // Partial sign without self-verification so the test can call verifyPartial itself.
            const s1 = musig.partialSign({ secretKey: sk1, publicNonce: n1, sessionKey: session, verify: false });

            expect(musig.verifyPartial({
                sig: s1, publicKey: pk1, publicNonce: n1, sessionKey: session,
            })).to.equal(true);
        });

        it('verifyPartial rejects a tampered partial signature', function () {
            const sk1 = crypto.randomBytes(32);
            const sk2 = crypto.randomBytes(32);
            const pk1 = secp256k1.getPublicKey(sk1, true);
            const pk2 = secp256k1.getPublicKey(sk2, true);
            const ctx = musig.aggregateKeys([pk1, pk2]);
            const msg = crypto.randomBytes(32);
            const n1 = musig.generateNonce({ publicKey: pk1, secretKey: sk1, msg, xOnlyPublicKey: ctx.xOnlyPubkey });
            const n2 = musig.generateNonce({ publicKey: pk2, secretKey: sk2, msg, xOnlyPublicKey: ctx.xOnlyPubkey });
            const aggNonce = musig.aggregateNonces([n1, n2]);
            const session = musig.startSession(aggNonce, msg, [pk1, pk2]);
            const s1 = musig.partialSign({ secretKey: sk1, publicNonce: n1, sessionKey: session, verify: false });

            // Flip a byte
            const tampered = new Uint8Array(s1);
            tampered[0] = tampered[0] ^ 0x01;

            expect(musig.verifyPartial({
                sig: tampered, publicKey: pk1, publicNonce: n1, sessionKey: session,
            })).to.equal(false);
        });
    });

    /*
     *  Sort order: BIP327 specifies a canonical lexicographic order.
     *  sortKeys must be deterministic.
     */

    describe('sortKeys', function () {
        it('returns keys in byte-lexicographic order', function () {
            const A = h('02' + 'aa'.repeat(32));
            const B = h('02' + 'bb'.repeat(32));
            const C = h('02' + '01'.repeat(32));

            const sorted = musig.sortKeys([B, A, C]);
            expect(toHex(sorted[0])).to.equal(toHex(C));
            expect(toHex(sorted[1])).to.equal(toHex(A));
            expect(toHex(sorted[2])).to.equal(toHex(B));
        });
    });

    /*
     *  A different message under the same key-agg must produce a
     *  different aggregated signature.
     */

    describe('message-binding', function () {
        it('signatures differ for different messages under the same keys', function () {
            const sk1 = crypto.randomBytes(32);
            const sk2 = crypto.randomBytes(32);
            const pk1 = secp256k1.getPublicKey(sk1, true);
            const pk2 = secp256k1.getPublicKey(sk2, true);
            const ctx = musig.aggregateKeys([pk1, pk2]);

            const sign = (msg) => {
                const n1 = musig.generateNonce({ publicKey: pk1, secretKey: sk1, msg, xOnlyPublicKey: ctx.xOnlyPubkey });
                const n2 = musig.generateNonce({ publicKey: pk2, secretKey: sk2, msg, xOnlyPublicKey: ctx.xOnlyPubkey });
                const aggNonce = musig.aggregateNonces([n1, n2]);
                const session = musig.startSession(aggNonce, msg, [pk1, pk2]);
                const s1 = musig.partialSign({ secretKey: sk1, publicNonce: n1, sessionKey: session });
                const s2 = musig.partialSign({ secretKey: sk2, publicNonce: n2, sessionKey: session });
                return { sig: musig.aggregateSignatures([s1, s2], session), msg };
            };

            const a = sign(crypto.randomBytes(32));
            const b = sign(crypto.randomBytes(32));

            expect(toHex(a.sig)).to.not.equal(toHex(b.sig));
            expect(schnorr.verify(a.sig, a.msg, ctx.xOnlyPubkey)).to.equal(true);
            expect(schnorr.verify(b.sig, b.msg, ctx.xOnlyPubkey)).to.equal(true);
        });
    });
});
