// Unit coverage for the SDK's copy of src/applyBufferutilsPatch.js. The SDK
// patches bitcoinjs bufferutils so 64-bit amount fields round-trip through a
// BigInt-safe path (values above 2^53 would otherwise silently corrupt on the
// wire). Exercises the patched read/write and varint helpers.

const assert = require('assert');
const bufferutils = require('../../src/applyBufferutilsPatch.js');

describe('applyBufferutilsPatch', function () {
    it('exposes the patched bufferutils surface', function () {
        assert.strictEqual(typeof bufferutils.readUInt64LE, 'function');
        assert.strictEqual(typeof bufferutils.writeUInt64LE, 'function');
        assert.ok(bufferutils.varuint && typeof bufferutils.varuint.encode === 'function');
    });

    it('round-trips a value above 2^53 without precision loss', function () {
        const big = 9007199254740993n; // 2^53 + 1
        const buf = Buffer.alloc(8);
        bufferutils.writeUInt64LE(buf, big, 0);
        assert.strictEqual(BigInt(bufferutils.readUInt64LE(buf, 0)), big);
    });

    it('varuint encode/decode round-trips across size classes', function () {
        for (const n of [0, 252, 253, 65535, 65536, 4294967295]) {
            const enc = bufferutils.varuint.encode(n);
            assert.strictEqual(Number(bufferutils.varuint.decode(enc, 0)), n, `varuint failed for ${n}`);
        }
    });

    // The write-side contract this copy ships (and that the header documents):
    // readers narrow to a Number at or below 2^53-1 and return a BigInt above
    // it; the module-level helpers accept the full u64 range. The decoder and
    // utxo-tracker copies deliberately differ (always-BigInt reader, stock
    // 2^53-1 helper ceiling), so this pins THIS copy rather than a shared one.
    it('narrows a representable value to Number and keeps a BigInt only above 2^53-1', function () {
        const buf = Buffer.alloc(8);
        bufferutils.writeUInt64LE(buf, 9007199254740991n, 0);          // 2^53-1
        assert.strictEqual(bufferutils.readUInt64LE(buf, 0), 9007199254740991);
        assert.strictEqual(typeof new bufferutils.BufferReader(buf).readUInt64(), 'number');
        bufferutils.writeUInt64LE(buf, 9007199254740992n, 0);          // 2^53
        assert.strictEqual(bufferutils.readUInt64LE(buf, 0), 9007199254740992n);
        assert.strictEqual(typeof new bufferutils.BufferReader(buf).readUInt64(), 'bigint');
    });

    it('module-level helpers accept the full u64 range and reject one past it', function () {
        const buf = Buffer.alloc(8);
        bufferutils.writeUInt64LE(buf, 0xffffffffffffffffn, 0);
        assert.strictEqual(bufferutils.readUInt64LE(buf, 0), 0xffffffffffffffffn);
        assert.throws(() => bufferutils.writeUInt64LE(buf, 0x10000000000000000n, 0), /value out of range/);
    });

    // Fee-accounting wrapper: bitcoinjs-lib's stock cache getter tests __FEE /
    // __FEE_RATE for truthiness, so a primed 0 (zero fee, or any fee under
    // 1 sat/vbyte) must be answered by the wrapper itself rather than by
    // re-running stock, which would re-throw the BigInt-mixing TypeError.
    describe('BigInt fee accounting (getFee / getFeeRate / extractTransaction)', function () {
        const { Psbt } = require('bitcoinjs-lib');
        function finalizedPsbt(inputValue, outputValue) {
            const psbt = new Psbt();
            psbt.addInput({
                hash: Buffer.alloc(32, 1), index: 0,
                witnessUtxo: { script: Buffer.from('0014' + '11'.repeat(20), 'hex'), value: inputValue }
            });
            psbt.addOutput({ script: Buffer.from('0014' + '22'.repeat(20), 'hex'), value: outputValue });
            // An empty witness stack is enough for isFinalized; no signing needed.
            psbt.updateInput(0, { finalScriptWitness: Buffer.from([0]) });
            return psbt;
        }

        it('returns 0 for a zero-fee PSBT with BigInt values instead of re-throwing', function () {
            const psbt = finalizedPsbt(1000n, 1000n);
            assert.strictEqual(psbt.getFee(), 0);
            assert.strictEqual(psbt.getFeeRate(), 0);
            assert.ok(psbt.extractTransaction());
        });

        it('returns a 0 fee rate for a sub-1-sat/vbyte fee instead of re-throwing', function () {
            const psbt = finalizedPsbt(100000n, 99990n);
            assert.strictEqual(psbt.getFee(), 10);
            assert.strictEqual(psbt.getFeeRate(), 0);
            assert.ok(psbt.extractTransaction());
        });

        it('still computes a non-zero fee and fee rate across the BigInt path', function () {
            const psbt = finalizedPsbt(9007199254740993n, 9007199254740000n);  // input above 2^53
            assert.strictEqual(psbt.getFee(), 993);
            assert.ok(psbt.getFeeRate() > 0);
            assert.ok(psbt.extractTransaction());
        });

        it('the all-Number fast path is unchanged', function () {
            const psbt = finalizedPsbt(100000, 90000);
            assert.strictEqual(psbt.getFee(), 10000);
            assert.ok(psbt.getFeeRate() > 0);
        });
    });
});
