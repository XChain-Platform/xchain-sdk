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
});
