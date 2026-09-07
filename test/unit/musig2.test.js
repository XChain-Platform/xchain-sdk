// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

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

        it('aggregateKeys throws when a participant key repeats', function () {
            // A repeated key collapses the threshold to one signer, so the
            // 2-of-2, the 2-of-3 recovery leaves, and the daemon policy all
            // depend on this rejection.
            const dup = h('02'.padEnd(66, '0'));
            expect(() => musig.aggregateKeys([dup, dup])).to.throw(/pairwise distinct/);
            expect(() => musig.aggregateKeys([dup, h('03'.padEnd(66, '0')), dup]))
                .to.throw(/pairwise distinct/);
            // Hex and Uint8Array forms of the same key are the same participant.
            expect(() => musig.aggregateKeys([dup, '02'.padEnd(66, '0')]))
                .to.throw(/pairwise distinct/);
        });

        it('aggregateKeys throws on bad pubkey element', function () {
            expect(() => musig.aggregateKeys([h('02'.padEnd(66, '0')), 12345])).to.throw(/hex string or Uint8Array/);
        });

        it('generateNonce treats a sessionId as single-use, whatever the other inputs', function () {
            // BIP327 derives the SECRET nonce from the sessionId, so ANY second
            // nonce under one sessionId is a second live handle on the same secret
            // nonce, and two partial signatures under it disclose the private key.
            const sk = crypto.randomBytes(32);
            const pk = Buffer.from(secp256k1.getPublicKey(sk, true));
            const sessionId = crypto.randomBytes(32);
            const msgA = crypto.randomBytes(32), msgB = crypto.randomBytes(32);
            musig.generateNonce({ publicKey: pk, secretKey: sk, sessionId, msg: msgA });
            expect(() => musig.generateNonce({ publicKey: pk, secretKey: sk, sessionId, msg: msgB }))
                .to.throw(/sessionId was already used/);
            // A byte-identical repeat is refused too: it regenerates the same secret
            // nonce, which is then spendable under a different aggregate nonce.
            expect(() => musig.generateNonce({ publicKey: pk, secretKey: sk, sessionId, msg: msgA }))
                .to.throw(/sessionId was already used/);
            // Omitting the sessionId leaves entropy to the library; nothing to reuse.
            expect(() => musig.generateNonce({ publicKey: pk, secretKey: sk, msg: msgB })).to.not.throw();
        });

        it('generateNonce refuses a msg-less sessionId repeat, and the repeat would have re-issued one secret nonce', function () {
            // Round 1 normally runs BEFORE the message is known, so a msg-less
            // repeat was the ordinary shape the old inputs-digest guard waved
            // through. Prove the hazard is real, then prove the guard refuses it.
            const sk = crypto.randomBytes(32);
            const pk = Buffer.from(secp256k1.getPublicKey(sk, true));
            const sessionId = crypto.randomBytes(32);
            const first = musig.generateNonce({ publicKey: pk, secretKey: sk, sessionId });
            expect(() => musig.generateNonce({ publicKey: pk, secretKey: sk, sessionId }))
                .to.throw(/sessionId was already used/);
            // Negative control: nonceGen is deterministic in (sessionId, secretKey,
            // publicKey), so a repeat the guard does NOT see re-issues the same 66
            // bytes as a distinct object, i.e. a second live handle on one secret
            // nonce. A fresh module copy has an empty guard set and shows exactly it.
            const musigPath = require.resolve('../../src/musig2.js');
            const cached = require.cache[musigPath];
            delete require.cache[musigPath];
            const FreshMuSig2 = require('../../src/musig2.js');
            delete require.cache[musigPath];
            require.cache[musigPath] = cached;
            const second = new FreshMuSig2().generateNonce({ publicKey: pk, secretKey: sk, sessionId });
            expect(Buffer.from(second).toString('hex')).to.equal(Buffer.from(first).toString('hex'));
            expect(second).to.not.equal(first);
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
     *  Cross-process 2-of-2 via deterministicSign: the keystone for a
     *  remote co-signer. Signer B runs on a SEPARATE MuSig2 instance and
     *  never calls generateNonce (no in-process secret-nonce cache to rely
     *  on), proving a stateless co-signer can participate end-to-end.
     */

    describe('cross-process 2-of-2 (deterministicSign)', function () {
        it('a separate-instance stateless co-signer produces a partial that aggregates + verifies', function () {
            const agent    = new MuSig2();   // signer A (holds a cached secret nonce)
            const cosigner = new MuSig2();   // signer B (different instance == different process)

            const skA = crypto.randomBytes(32);
            const skB = crypto.randomBytes(32);
            const pkA = secp256k1.getPublicKey(skA, true);
            const pkB = secp256k1.getPublicKey(skB, true);
            const keys = [pkA, pkB];                       // agreed order, both sides
            const ctx  = agent.aggregateKeys(keys);
            const msg  = crypto.randomBytes(32);

            // Round 1: agent makes its nonce; secret nonce stays inside `agent`.
            const nA = agent.generateNonce({ publicKey: pkA, secretKey: skA, msg, xOnlyPublicKey: ctx.xOnlyPubkey });

            // Co-signer: ONE stateless call. No prior generateNonce on `cosigner`.
            const det = cosigner.deterministicSign({ secretKey: skB, otherPublicNonces: [nA], publicKeys: keys, msg });
            expect(det.publicNonce.length).to.equal(66);
            expect(det.sig.length).to.equal(32);

            // Agent finishes from the co-signer's returned nonce + its own cached secret nonce.
            const aggNonce = agent.aggregateNonces([nA, det.publicNonce]);
            const session  = agent.startSession(aggNonce, msg, keys);
            const sA       = agent.partialSign({ secretKey: skA, publicNonce: nA, sessionKey: session });

            // The co-signer's partial must verify in the agent-built session...
            expect(agent.verifyPartial({ sig: det.sig, publicKey: pkB, publicNonce: det.publicNonce, sessionKey: session }))
                .to.equal(true);

            // ...and the aggregate is a plain BIP340 Schnorr sig under the aggregated key.
            const sig = agent.aggregateSignatures([sA, det.sig], session);
            expect(schnorr.verify(sig, msg, ctx.xOnlyPubkey)).to.equal(true);
        });

        it('accepts a pre-aggregated aggOtherNonce equivalently to otherPublicNonces', function () {
            const agent    = new MuSig2();
            const cosigner = new MuSig2();
            const skA = crypto.randomBytes(32), skB = crypto.randomBytes(32);
            const pkA = secp256k1.getPublicKey(skA, true), pkB = secp256k1.getPublicKey(skB, true);
            const keys = [pkA, pkB];
            const ctx = agent.aggregateKeys(keys);
            const msg = crypto.randomBytes(32);
            const nA  = agent.generateNonce({ publicKey: pkA, secretKey: skA, msg, xOnlyPublicKey: ctx.xOnlyPubkey });

            // For a single counterparty, the aggregate of "all other nonces" is nA itself.
            const det = cosigner.deterministicSign({ secretKey: skB, aggOtherNonce: nA, publicKeys: keys, msg });
            const aggNonce = agent.aggregateNonces([nA, det.publicNonce]);
            const session  = agent.startSession(aggNonce, msg, keys);
            const sA = agent.partialSign({ secretKey: skA, publicNonce: nA, sessionKey: session });
            const sig = agent.aggregateSignatures([sA, det.sig], session);
            expect(schnorr.verify(sig, msg, ctx.xOnlyPubkey)).to.equal(true);
        });

        it('is deterministic for fixed inputs but binds the message (no nonce reuse across messages)', function () {
            const cosigner = new MuSig2();
            const skB = crypto.randomBytes(32);
            const pkA = secp256k1.getPublicKey(crypto.randomBytes(32), true);
            const pkB = secp256k1.getPublicKey(skB, true);
            const keys = [pkA, pkB];
            const nA  = new MuSig2().generateNonce({ publicKey: pkA, secretKey: crypto.randomBytes(32) });
            const msg1 = crypto.randomBytes(32);
            const msg2 = crypto.randomBytes(32);

            const a = cosigner.deterministicSign({ secretKey: skB, otherPublicNonces: [nA], publicKeys: keys, msg: msg1, nonceOnly: true });
            const b = cosigner.deterministicSign({ secretKey: skB, otherPublicNonces: [nA], publicKeys: keys, msg: msg1, nonceOnly: true });
            const c = cosigner.deterministicSign({ secretKey: skB, otherPublicNonces: [nA], publicKeys: keys, msg: msg2, nonceOnly: true });

            expect(toHex(a.publicNonce)).to.equal(toHex(b.publicNonce));   // same inputs -> same nonce
            expect(toHex(a.publicNonce)).to.not.equal(toHex(c.publicNonce)); // different msg -> different nonce
        });

        it('rejects when neither aggOtherNonce nor otherPublicNonces is provided', function () {
            const cosigner = new MuSig2();
            const skB = crypto.randomBytes(32);
            const pkA = secp256k1.getPublicKey(crypto.randomBytes(32), true);
            const pkB = secp256k1.getPublicKey(skB, true);
            expect(() => cosigner.deterministicSign({ secretKey: skB, publicKeys: [pkA, pkB], msg: crypto.randomBytes(32) }))
                .to.throw(/aggOtherNonce.*otherPublicNonces|otherPublicNonces/);
        });

        it('rejects a mis-sized msg', function () {
            const cosigner = new MuSig2();
            const skB = crypto.randomBytes(32);
            const pkA = secp256k1.getPublicKey(crypto.randomBytes(32), true);
            const pkB = secp256k1.getPublicKey(skB, true);
            expect(() => cosigner.deterministicSign({ secretKey: skB, otherPublicNonces: [new Uint8Array(66)], publicKeys: [pkA, pkB], msg: h('ab') }))
                .to.throw(/msg must be 32 bytes/);
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
