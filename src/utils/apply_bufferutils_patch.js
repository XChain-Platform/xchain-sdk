/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * In-process BigInt-safe 64-bit value patch for bitcoinjs-lib + bip174.
 *
 * Stock bitcoinjs-lib 6.x holds transaction output values as Number and
 * bounds them twice: the 64-bit serializers (bufferutils verifuint, and
 * bip174's own copy for the PSBT witnessUtxo field) throw 'RangeError:
 * value out of range' above 2^53-1, and types.Satoshi additionally caps
 * addOutput at 21M BTC in sats (2.1e15). Dogecoin has no supply cap, so a
 * single output can legitimately exceed both ceilings (>~90.07M DOGE for
 * 2^53); without this patch the encoder cannot build such a PSBT at all.
 *
 * This is the WRITE-SIDE contract, shared with
 * xchain-encoder/src/build/apply_bufferutils_patch.js: the patch teaches the loaded
 * modules to carry a satoshi value as either a Number (unchanged fast path)
 * or a BigInt up to 2^64-1 (the wire format's true ceiling). Readers return
 * a Number whenever the value is exactly representable and a BigInt only
 * above 2^53-1, so existing Number-based callers see identical behavior for
 * every value they could already handle. The READ-SIDE copies
 * (xchain-decoder/src/chain/apply_bufferutils_patch.js and
 * xchain-utxo-tracker/src/chain/apply_bufferutils_patch.js)
 * lift the same 2^53 wall for block decode but deliberately implement a
 * DIFFERENT contract: BufferReader.readUInt64 always returns a BigInt and
 * the module-level readUInt64LE/writeUInt64LE helpers keep the stock 2^53-1
 * ceiling. Only the 2^53 probe and the error strings are common to both.
 *
 * Re-sync seam (uuid:311476c7). Everything below this banner is pinned
 * byte-identical to the encoder copy's body by
 * xchain-encoder/test/unit/build/apply_bufferutils_patch.test.js. Only the two
 * headers differ, because each names the other and its own read-side
 * relationship.
 * Convergence runs SDK-ward: change this copy first, then copy its body to the
 * encoder, or the twin guard goes red.
 *
 * All bitcoinjs-lib/bip174 consumers hold the patched modules' exports
 * objects and class prototypes rather than destructured copies, so
 * mutating them here retrofits every current and future caller.
 *
 ********************************************************************/

const bufferutils = require('bitcoinjs-lib/src/bufferutils')
const bitcoinTypes = require('bitcoinjs-lib/src/types')
const bip174Tools = require('bip174/src/lib/converter/tools')
const bitcoin = require('bitcoinjs-lib')
const { Psbt, Transaction } = bitcoin

const MAX_U64 = 0xffffffffffffffffn
const MAX_SAFE_BIG = BigInt(Number.MAX_SAFE_INTEGER)
const IS_BITCOINJS_V7 = !!bitcoinTypes.SatoshiSchema

function withBigIntValue(data) {
    if (!data || typeof data.value !== 'number') return data
    return Object.assign({}, data, { value: verifyU64(data.value) })
}

function withBigIntWitnessUtxo(data) {
    if (!data || !data.witnessUtxo || typeof data.witnessUtxo.value !== 'number') return data
    return Object.assign({}, data, { witnessUtxo: withBigIntValue(data.witnessUtxo) })
}

function compatibleValue(value) {
    if (value instanceof Uint8Array && !Buffer.isBuffer(value)) return Buffer.from(value)
    if (Array.isArray(value)) return value.map(compatibleValue)
    return value
}

function compatiblePayment(payment) {
    if (!payment || typeof payment !== 'object') return payment
    for (const name of Object.getOwnPropertyNames(payment)) {
        const descriptor = Object.getOwnPropertyDescriptor(payment, name)
        if (descriptor.get) {
            Object.defineProperty(payment, name, Object.assign({}, descriptor, {
                get() { return compatibleValue(descriptor.get.call(this)) }
            }))
        } else if ('value' in descriptor) {
            payment[name] = compatibleValue(descriptor.value)
        }
    }
    return payment
}

function compatibleTransaction(tx, narrowValues) {
    for (const input of tx.ins) {
        input.hash = compatibleValue(input.hash)
        input.script = compatibleValue(input.script)
        input.witness = compatibleValue(input.witness)
    }
    for (const output of tx.outs) {
        output.script = compatibleValue(output.script)
        if (narrowValues && typeof output.value === 'bigint' && output.value <= MAX_SAFE_BIG) {
            output.value = Number(output.value)
        }
    }
    return tx
}

function bufferize(value) {
    if (value instanceof Uint8Array && !Buffer.isBuffer(value)) return Buffer.from(value)
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) value[i] = bufferize(value[i])
        return value
    }
    if (value && typeof value === 'object') {
        for (const name of Object.keys(value)) value[name] = bufferize(value[name])
    }
    return value
}

function compatiblePsbt(psbt) {
    bufferize(psbt.data.globalMap)
    bufferize(psbt.data.inputs)
    bufferize(psbt.data.outputs)
    return psbt
}

if (IS_BITCOINJS_V7 && !Transaction.prototype.__xchainNumberValues) {
    const valibot = require('valibot')
    bitcoinTypes.SatoshiSchema = valibot.pipe(
        valibot.bigint(), valibot.minValue(0n), valibot.maxValue(MAX_U64)
    )
    const uint8Tools = require('uint8array-tools')
    uint8Tools.writeInt64 = uint8Tools.writeUInt64
    uint8Tools.readInt64 = uint8Tools.readUInt64
    bufferutils.readUInt64LE = function (buffer, offset) {
        return narrowU64(uint8Tools.readUInt64(buffer, offset, 'LE'))
    }
    bufferutils.writeUInt64LE = function (buffer, value, offset) {
        uint8Tools.writeUInt64(buffer, offset, verifyU64(value), 'LE')
        return offset + 8
    }
    bufferutils.BufferWriter.prototype.writeInt64 = function (value) {
        this.offset = uint8Tools.writeUInt64(this.buffer, this.offset, verifyU64(value), 'LE')
    }
    bufferutils.BufferWriter.prototype.writeUInt64 = bufferutils.BufferWriter.prototype.writeInt64
    bufferutils.BufferReader.prototype.readInt64 = function () {
        const value = uint8Tools.readUInt64(this.buffer, this.offset, 'LE')
        this.offset += 8
        return value
    }
    bufferutils.BufferReader.prototype.readUInt64 = function () {
        const value = narrowU64(uint8Tools.readUInt64(this.buffer, this.offset, 'LE'))
        this.offset += 8
        return value
    }

    const varuint = bufferutils.varuint
    const encodeVarInt = function (value, buffer, offset) {
        const result = varuint.encode(value, buffer, offset)
        encodeVarInt.bytes = result.bytes
        return compatibleValue(result.buffer)
    }
    const decodeVarInt = function (buffer, offset) {
        const result = varuint.decode(buffer, offset)
        decodeVarInt.bytes = result.bytes
        return result.numberValue === null ? result.bigintValue : result.numberValue
    }
    bufferutils.varuint = {
        encode: encodeVarInt,
        decode: decodeVarInt,
        encodingLength: varuint.encodingLength,
    }

    const addOutput = Transaction.prototype.addOutput
    Transaction.prototype.addOutput = function (script, value) {
        return addOutput.call(this, script, typeof value === 'number' ? BigInt(value) : value)
    }
    Transaction.prototype.__xchainNumberValues = true

    const fromBuffer = Transaction.fromBuffer
    Transaction.fromBuffer = function (...args) {
        return compatibleTransaction(fromBuffer.apply(this, args), false)
    }
    const fromHex = Transaction.fromHex
    Transaction.fromHex = function (...args) {
        return compatibleTransaction(fromHex.apply(this, args), true)
    }
    const getHash = Transaction.prototype.getHash
    Transaction.prototype.getHash = function (...args) {
        return compatibleValue(getHash.apply(this, args))
    }
    const toBuffer = Transaction.prototype.toBuffer
    Transaction.prototype.toBuffer = function (...args) {
        return compatibleValue(toBuffer.apply(this, args))
    }
    const hashForWitnessV0 = Transaction.prototype.hashForWitnessV0
    Transaction.prototype.hashForWitnessV0 = function (index, script, value, hashType) {
        return compatibleValue(hashForWitnessV0.call(
            this, index, script, typeof value === 'number' ? BigInt(value) : value, hashType
        ))
    }
    const hashForWitnessV1 = Transaction.prototype.hashForWitnessV1
    Transaction.prototype.hashForWitnessV1 = function (index, scripts, values, ...args) {
        return compatibleValue(hashForWitnessV1.call(
            this, index, scripts, values.map((value) => typeof value === 'number' ? BigInt(value) : value), ...args
        ))
    }

    const addInput = Psbt.prototype.addInput
    Psbt.prototype.addInput = function (data) {
        const result = addInput.call(this, withBigIntWitnessUtxo(data))
        bufferize(this.data.inputs[this.data.inputs.length - 1])
        return result
    }
    const updateInput = Psbt.prototype.updateInput
    Psbt.prototype.updateInput = function (index, data) {
        const result = updateInput.call(this, index, withBigIntWitnessUtxo(data))
        bufferize(this.data.inputs[index])
        return result
    }
    const addPsbtOutput = Psbt.prototype.addOutput
    Psbt.prototype.addOutput = function (data) {
        const result = addPsbtOutput.call(this, withBigIntValue(data))
        bufferize(this.data.outputs[this.data.outputs.length - 1])
        return result
    }

    const psbtFromBuffer = Psbt.fromBuffer
    Psbt.fromBuffer = function (...args) {
        return compatiblePsbt(psbtFromBuffer.apply(this, args))
    }

    for (const name of ['signInput', 'signAllInputs', 'finalizeInput', 'finalizeAllInputs']) {
        const method = Psbt.prototype[name]
        Psbt.prototype[name] = function (...args) {
            const result = method.apply(this, args)
            compatiblePsbt(this)
            return result
        }
    }

    for (const name of ['txInputs', 'txOutputs']) {
        const descriptor = Object.getOwnPropertyDescriptor(Psbt.prototype, name)
        Object.defineProperty(Psbt.prototype, name, Object.assign({}, descriptor, {
            get() {
                return bufferize(descriptor.get.call(this))
            }
        }))
    }

    const extractTransaction = Psbt.prototype.extractTransaction
    Psbt.prototype.extractTransaction = function (...args) {
        return compatibleTransaction(extractTransaction.apply(this, args), true)
    }
    const getFee = Psbt.prototype.getFee
    Psbt.prototype.getFee = function (...args) {
        const fee = getFee.apply(this, args)
        return typeof fee === 'bigint' && fee <= MAX_SAFE_BIG ? Number(fee) : fee
    }
    const psbtToBuffer = Psbt.prototype.toBuffer
    Psbt.prototype.toBuffer = function (...args) {
        return compatibleValue(psbtToBuffer.apply(this, args))
    }

    for (const name of Object.keys(bitcoin.payments)) {
        const payment = bitcoin.payments[name]
        if (typeof payment !== 'function') continue
        Object.defineProperty(bitcoin.payments, name, {
            configurable: true,
            enumerable: true,
            writable: true,
            value: function (...args) {
                return compatiblePayment(payment.apply(this, args))
            },
        })
    }
    for (const group of [bitcoin.script, bitcoin.crypto]) {
        for (const name of Object.keys(group)) {
            const fn = group[name]
            if (typeof fn !== 'function') continue
            Object.defineProperty(group, name, {
                configurable: true,
                enumerable: true,
                writable: true,
                value: function (...args) {
                    return compatibleValue(fn.apply(this, args))
                },
            })
        }
    }
    const psbtutils = require('bitcoinjs-lib/src/psbt/psbtutils')
    for (const name of Object.keys(psbtutils)) {
        const fn = psbtutils[name]
        if (typeof fn !== 'function') continue
        psbtutils[name] = function (...args) {
            return compatibleValue(fn.apply(this, args))
        }
    }
}

// Bounds-check a satoshi value that may be a Number or a BigInt, mirroring
// stock verifuint's error strings so callers relying on them keep working.
// Guard order is stock verifuint's, not a preference: non-number, negative,
// upper bound, fractional. Testing fractional first made -0.5 report a
// fractional component where stock reports a negative value, and converting to
// BigInt before the range check let +/-Infinity escape as a native BigInt
// RangeError instead of either stock string. Comparing before converting is
// what fixes both, and mixed Number/BigInt relational comparison is legal, so
// one pair of comparisons covers both accepted types (NaN fails both and falls
// to the fractional branch, exactly as stock does).
function verifyU64(value) {
    if (typeof value !== 'number' && typeof value !== 'bigint') {
        throw new Error('cannot write a non-number as a number')
    }
    if (value < 0) {
        throw new Error('specified a negative value for writing an unsigned value')
    }
    // Cap a Number at stock's 2^53-1, since past it the value is no longer exact; a BigInt
    // carries anything larger, up to the wire's 2^64-1.
    if (value > MAX_U64 || (typeof value === 'number' && value > Number.MAX_SAFE_INTEGER)) {
        throw new Error('RangeError: value out of range')
    }
    if (typeof value === 'number' && Math.floor(value) !== value) {
        throw new Error('value has a fractional component')
    }
    return BigInt(value)
}

// Number when exactly representable, BigInt above 2^53-1. Keeps every
// pre-patch caller seeing the same type it always saw.
function narrowU64(big) {
    return big <= MAX_SAFE_BIG ? Number(big) : big
}

// Probe with a 2^53 uint64, one past the stock serializers' ceiling: stock
// code throws, the patched reader returns it. Idempotence guard (the patch
// may already be active when several entry points require this module).
function bigIntReaderActive(bu) {
    try {
        new bu.BufferReader(Buffer.from([0, 0, 0, 0, 0, 0, 0x20, 0])).readUInt64()
        return true
    } catch (_) {
        return false
    }
}

if (!IS_BITCOINJS_V7 && !bigIntReaderActive(bufferutils)) {
    bufferutils.readUInt64LE = function readUInt64LE(buffer, offset) {
        return narrowU64(buffer.readBigUInt64LE(offset))
    }

    bufferutils.writeUInt64LE = function writeUInt64LE(buffer, value, offset) {
        buffer.writeBigUInt64LE(verifyU64(value), offset)
        return offset + 8
    }

    bufferutils.BufferReader.prototype.readUInt64 = function readUInt64() {
        // Bitcoin wire tx output value is an UNSIGNED 64-bit LE integer; the
        // signed reader would decode a value >= 2^63 as a negative BigInt.
        const result = narrowU64(this.buffer.readBigUInt64LE(this.offset))
        this.offset += 8
        return result
    }

    bufferutils.BufferWriter.prototype.writeUInt64 = function writeUInt64(value) {
        this.offset = this.buffer.writeBigUInt64LE(verifyU64(value), this.offset)
    }
}

// types.Satoshi gates Transaction.addOutput (typeforce). Stock form is
// UInt53(value) && value <= 21e14, a bitcoin-specific supply cap that is
// simply wrong for Dogecoin (no cap). Accept any exact u64: Number up to
// 2^53-1, BigInt up to 2^64-1. Upstream validators (validator.js
// parseSatoshiAmount) remain the semantic bound for caller input.
if (!IS_BITCOINJS_V7 && !bitcoinTypes.Satoshi(MAX_U64)) {
    bitcoinTypes.Satoshi = function Satoshi(value) {
        if (typeof value === 'bigint') return value >= 0n && value <= MAX_U64
        return bitcoinTypes.typeforce.UInt53(value)
    }
}

// bip174 carries its own 64-bit serializer copy for the PSBT witnessUtxo
// value field; patch it the same way or a >2^53 segwit input value would
// still throw at PSBT serialization time.
if (!IS_BITCOINJS_V7 && !(() => { try { bip174Tools.readUInt64LE(Buffer.from([0, 0, 0, 0, 0, 0, 0x20, 0]), 0); return true } catch (_) { return false } })()) {
    bip174Tools.readUInt64LE = function readUInt64LE(buffer, offset) {
        return narrowU64(buffer.readBigUInt64LE(offset))
    }

    bip174Tools.writeUInt64LE = function writeUInt64LE(buffer, value, offset) {
        buffer.writeBigUInt64LE(verifyU64(value), offset)
        return offset + 8
    }
}

// bip174's witnessUtxo converter type-check hard-codes
// `typeof data.value === 'number'`, so a BigInt input value is rejected at
// Psbt.addInput before serialization. Widen it to accept BigInt too.
const witnessUtxoConverter = require('bip174/src/lib/converter/input/witnessUtxo')
if (!IS_BITCOINJS_V7 && !witnessUtxoConverter.check({ script: Buffer.alloc(1), value: 1n })) {
    witnessUtxoConverter.check = function check(data) {
        return Buffer.isBuffer(data.script) &&
            (typeof data.value === 'number' || typeof data.value === 'bigint')
    }
    witnessUtxoConverter.expected = '{ script: Buffer; value: number | bigint; }'
}

// psbt.js's internal PsbtTransaction wrapper (not exported) hard-codes
// `typeof output.value !== 'number'` in addOutput, so a BigInt value throws
// 'Error adding output.' before it ever reaches the patched serializers.
// Reach its prototype through a throwaway Psbt instance and widen the check.
const psbtTxProto = Object.getPrototypeOf(new Psbt().data.globalMap.unsignedTx)
if (!IS_BITCOINJS_V7 && !psbtTxProto.__xchainBigIntValues) {
    psbtTxProto.addOutput = function addOutput(output) {
        if (
            output.script === undefined ||
            output.value === undefined ||
            !Buffer.isBuffer(output.script) ||
            (typeof output.value !== 'number' && typeof output.value !== 'bigint')
        ) {
            throw new Error('Error adding output.')
        }
        this.tx.addOutput(output.script, output.value)
    }
    psbtTxProto.__xchainBigIntValues = true
}

// psbt.js's internal fee accounting (inputFinalizeGetAmts) sums input and
// output values with Number '+', which throws 'Cannot mix BigInt and other
// types' once any value is a BigInt. It runs inside extractTransaction /
// getFee / getFeeRate via module-internal closures we cannot reach, so wrap
// the public methods instead: use the stock implementation while its Number
// sums are exact and, when an exact total passes 2^53-1 (all-Number values
// can still sum past it on Dogecoin) or stock throws the BigInt-mixing
// TypeError, recompute the amounts BigInt-safely, prime the caches the
// stock helper would have primed, and answer from those caches ourselves.
// getFee / getFeeRate must NOT be re-run through stock after priming: stock
// getTxCacheValue tests the cache for TRUTHINESS, so a primed 0 (zero-fee
// PSBT, or any fee under 1 sat/vbyte) falls straight back into the Number
// summing and re-throws the very TypeError this wrapper exists to absorb.
// extractTransaction is safe to re-run: its checkFees reads the primed
// __FEE_RATE or calls the (wrapped) getFeeRate, and it returns the primed
// __EXTRACTED_TX.
function witnessStackFromScriptWitness(buffer) {
    // Inverse of psbt.js's internal scriptWitnessToWitnessStack: a varint
    // element count followed by var-sliced witness elements.
    let offset = 0
    const readVarInt = () => {
        const vi = bufferutils.varuint.decode(buffer, offset)
        offset += bufferutils.varuint.decode.bytes
        return vi
    }
    const count = readVarInt()
    const vector = []
    for (let i = 0; i < count; i++) {
        const n = readVarInt()
        vector.push(buffer.slice(offset, offset + n))
        offset += n
    }
    return vector
}

function primeBigIntSafeAmts(psbt) {
    const c = psbt.__CACHE
    const tx = c.__TX.clone()
    let inputAmount = 0n
    psbt.data.inputs.forEach((input, idx) => {
        if (input.finalScriptSig) tx.ins[idx].script = input.finalScriptSig
        if (input.finalScriptWitness) {
            tx.ins[idx].witness = witnessStackFromScriptWitness(input.finalScriptWitness)
        }
        if (input.witnessUtxo) {
            inputAmount += BigInt(input.witnessUtxo.value)
        } else if (input.nonWitnessUtxo) {
            const nwTx = Transaction.fromBuffer(input.nonWitnessUtxo)
            inputAmount += BigInt(nwTx.outs[tx.ins[idx].index].value)
        }
    })
    const outputAmount = tx.outs.reduce((total, o) => total + BigInt(o.value), 0n)
    const fee = inputAmount - outputAmount
    if (fee < 0n) {
        throw new Error('Outputs are spending more than Inputs')
    }
    // Fees are always tiny relative to 2^53; Number() is exact in practice
    // and the cached fee is only used for the fee-rate sanity check anyway.
    const feeNumber = Number(fee)
    c.__FEE = feeNumber
    c.__EXTRACTED_TX = tx
    c.__FEE_RATE = Math.floor(feeNumber / tx.virtualSize())
}

// Would stock's Number sums round? Values are non-negative, so every partial sum is
// bounded by its exact total. A PSBT that cannot be read here answers false, leaving
// stock to raise its own error for it.
function amountTotalsOverSafe(psbt) {
    try {
        const tx = psbt.__CACHE.__TX
        let inputAmount = 0n
        psbt.data.inputs.forEach((input, idx) => {
            if (input.witnessUtxo) inputAmount += BigInt(input.witnessUtxo.value)
            else if (input.nonWitnessUtxo)
                inputAmount += BigInt(Transaction.fromBuffer(input.nonWitnessUtxo).outs[tx.ins[idx].index].value)
        })
        const outputAmount = tx.outs.reduce((total, o) => total + BigInt(o.value), 0n)
        return inputAmount > MAX_SAFE_BIG || outputAmount > MAX_SAFE_BIG
    } catch (_) {
        return false
    }
}

// Stock's own finalized test; an unfinalized PSBT always goes to stock for its error.
const isFinalizedInput = (input) => !!input.finalScriptSig || !!input.finalScriptWitness

if (!IS_BITCOINJS_V7 && !Psbt.prototype.__xchainBigIntAmts) {
    for (const method of ['extractTransaction', 'getFee', 'getFeeRate']) {
        const stock = Psbt.prototype[method]
        Psbt.prototype[method] = function (...args) {
            if (!this.data.inputs.every(isFinalizedInput) || !amountTotalsOverSafe(this)) {
                try {
                    return stock.apply(this, args)
                } catch (err) {
                    if (!(err instanceof TypeError) || !/BigInt/.test(err.message)) throw err
                }
            }
            primeBigIntSafeAmts(this)
            if (method === 'getFee') return this.__CACHE.__FEE
            if (method === 'getFeeRate') return this.__CACHE.__FEE_RATE
            return stock.apply(this, args)
        }
        Object.defineProperty(Psbt.prototype[method], 'name', { value: method })
    }
    Psbt.prototype.__xchainBigIntAmts = true
}

module.exports = bufferutils
