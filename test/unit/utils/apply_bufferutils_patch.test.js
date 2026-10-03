// Unit coverage for the SDK's copy of src/utils/apply_bufferutils_patch.js. The SDK
// patches bitcoinjs bufferutils so 64-bit amount fields round-trip through a
// BigInt-safe path (values above 2^53 would otherwise silently corrupt on the
// wire). Exercises the patched read/write and varint helpers.

const assert = require('assert');
const bufferutils = require('../../../src/utils/apply_bufferutils_patch.js');

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

});

describe('applyBufferutilsPatch', function () {

    it('module-level helpers accept the full u64 range and reject one past it', function () {
        const buf = Buffer.alloc(8);
        bufferutils.writeUInt64LE(buf, 0xffffffffffffffffn, 0);
        assert.strictEqual(bufferutils.readUInt64LE(buf, 0), 0xffffffffffffffffn);
        assert.throws(() => bufferutils.writeUInt64LE(buf, 0x10000000000000000n, 0), /value out of range/);
    });

    // The header promises stock verifuint's error strings, and a caller that
    // branches on them only keeps working if EVERY rejected value produces the
    // one stock verifuint produces. Testing fractional before the range checks
    // broke that for -0.5, and converting to BigInt before them let +/-Infinity
    // out as a native BigInt RangeError that is neither stock string.
    it('rejects every invalid value with the stock verifuint string', function () {
        const buf = Buffer.alloc(8);
        const cases = [
            ['5',        /cannot write a non-number as a number/],
            [-0.5,       /specified a negative value for writing an unsigned value/],
            [-1,         /specified a negative value for writing an unsigned value/],
            [-1n,        /specified a negative value for writing an unsigned value/],
            [-Infinity,  /specified a negative value for writing an unsigned value/],
            [Infinity,   /value out of range/],
            [2 ** 53,    /value out of range/],
            [2 ** 60,    /value out of range/],
            [1e16 + 1,   /value out of range/],
            [1e30,       /value out of range/],
            [0.5,        /value has a fractional component/],
            [NaN,        /value has a fractional component/]
        ];
        for (const [value, expected] of cases) {
            assert.throws(() => bufferutils.writeUInt64LE(buf, value, 0), expected,
                'wrong error string for ' + String(value));
            // The native BigInt conversion error is the specific escape hatch
            // the guard order closes, so name it rather than only the shape.
            assert.throws(() => bufferutils.writeUInt64LE(buf, value, 0),
                (err) => !/cannot be converted to a BigInt/.test(err.message),
                'a native BigInt conversion error escaped for ' + String(value));
        }
    });

});

describe('applyBufferutilsPatch', function () {

    // A Number past 2^53-1 has already lost its exact value, so every writer refuses it
    // as stock verifuint does, while the same amount as a BigInt still serializes.
    it('caps a Number at 2^53-1 on every writer while a BigInt passes', function () {
        const buf = Buffer.alloc(8);
        bufferutils.writeUInt64LE(buf, 9007199254740991, 0);
        assert.strictEqual(bufferutils.readUInt64LE(buf, 0), 9007199254740991);
        bufferutils.writeUInt64LE(buf, 9007199254740992n, 0);
        assert.strictEqual(bufferutils.readUInt64LE(buf, 0), 9007199254740992n);
        assert.throws(() => new bufferutils.BufferWriter(Buffer.alloc(8)).writeUInt64(2 ** 53), /value out of range/);
        const bip174Tools = require('bip174/src/lib/converter/tools');
        assert.throws(() => bip174Tools.writeUInt64LE(Buffer.alloc(8), 2 ** 53, 0), /value out of range/);
    });

    it('refuses a PSBT witnessUtxo Number value past 2^53-1 and serializes its BigInt form', function () {
        const { Psbt } = require('bitcoinjs-lib');
        const input = (value) => ({ hash: Buffer.alloc(32, 1), index: 0,
            witnessUtxo: { script: Buffer.from('0014' + '11'.repeat(20), 'hex'), value } });
        assert.throws(() => { const psbt = new Psbt(); psbt.addInput(input(2 ** 53)); psbt.toBuffer(); },
            /value out of range/);
        const psbt = new Psbt();
        psbt.addInput(input(9007199254740992n));
        assert.ok(psbt.toBuffer().length > 0);
    });

});

describe('applyBufferutilsPatch', function () {

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

// Fee-accounting wrapper, large all-Number totals: each value is a safe Number but the
// inputs sum past 2^53-1, where stock Number '+' rounds without throwing.
describe('applyBufferutilsPatch', function () {
    const { Psbt } = require('bitcoinjs-lib');

    function multiPsbt(inputValues, outputValues, finalize = true) {
        const psbt = new Psbt();
        inputValues.forEach((value, i) => psbt.addInput({
            hash: Buffer.alloc(32, i + 1), index: 0,
            witnessUtxo: { script: Buffer.from('0014' + '11'.repeat(20), 'hex'), value }
        }));
        outputValues.forEach(value => psbt.addOutput({ script: Buffer.from('0014' + '22'.repeat(20), 'hex'), value }));
        if (finalize) inputValues.forEach((_, i) => psbt.updateInput(i, { finalScriptWitness: Buffer.from([0]) }));
        return psbt;
    }
    const BIG_INS = [4503599627370497, 4503599627370498];   // 2^52+1, 2^52+2: total 2^53+3

    it('computes an exact fee when all-Number totals pass 2^53-1', function () {
        assert.strictEqual(multiPsbt(BIG_INS, [9007199254740000]).getFee(), 995);
        assert.strictEqual(multiPsbt(BIG_INS, [4503599627370496, 4503599627370497]).getFee(), 2);
        assert.ok(multiPsbt(BIG_INS, [9007199254740000]).extractTransaction());
    });

    it('refuses an all-Number PSBT whose exact outputs exceed its inputs past 2^53-1', function () {
        const outs = [4503599627370498, 4503599627370498];   // true fee is -1, rounded fee is 0
        assert.throws(() => multiPsbt(BIG_INS, outs).getFee(), /Outputs are spending more than Inputs/);
        assert.throws(() => multiPsbt(BIG_INS, outs).extractTransaction(), /Outputs are spending more than Inputs/);
    });

    it('leaves an unfinalized large-total PSBT to stock\'s own error', function () {
        assert.throws(() => multiPsbt(BIG_INS, [9007199254740000], false).getFee(),
            /PSBT must be finalized to calculate fee/);
    });
});
