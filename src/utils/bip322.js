// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const crypto = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('@bitcoinerlab/secp256k1');

bitcoin.initEccLib(ecc);

const SIMPLE_PREFIX = 'smp';
const MESSAGE_TAG = 'BIP0322-signed-message';
const MAX_WITNESS_ITEMS = 100;
const MAX_WITNESS_ITEM_SIZE = 10000;

function asBuffer(value) {
    return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function messageHash(message) {
    if (typeof message !== 'string') throw new TypeError('Message must be a string.');
    const tagHash = crypto.createHash('sha256').update(MESSAGE_TAG, 'utf8').digest();
    return crypto.createHash('sha256')
        .update(tagHash)
        .update(tagHash)
        .update(message, 'utf8')
        .digest();
}

function p2trScript(address, network) {
    const script = asBuffer(bitcoin.address.toOutputScript(address, network));
    if (script.length !== 34 || script[0] !== bitcoin.opcodes.OP_1 || script[1] !== 0x20) {
        throw new TypeError('BIP-322 simple signing requires a P2TR address.');
    }
    return script;
}

function buildTransactions(message, address, network) {
    const challenge = p2trScript(address, network);
    const toSpend = new bitcoin.Transaction();
    toSpend.version = 0;
    toSpend.locktime = 0;
    toSpend.addInput(
        Buffer.alloc(32),
        0xffffffff,
        0,
        bitcoin.script.compile([bitcoin.opcodes.OP_0, messageHash(message)])
    );
    toSpend.addOutput(challenge, 0n);

    const toSign = new bitcoin.Transaction();
    toSign.version = 0;
    toSign.locktime = 0;
    toSign.addInput(asBuffer(toSpend.getHash()), 0, 0, Buffer.alloc(0));
    toSign.addOutput(Buffer.from([bitcoin.opcodes.OP_RETURN]), 0n);

    return { challenge, toSpend, toSign };
}

function encodeCompactSize(value) {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Invalid compact size.');
    if (value < 0xfd) return Buffer.from([value]);
    if (value <= 0xffff) {
        const encoded = Buffer.alloc(3);
        encoded[0] = 0xfd;
        encoded.writeUInt16LE(value, 1);
        return encoded;
    }
    if (value <= 0xffffffff) {
        const encoded = Buffer.alloc(5);
        encoded[0] = 0xfe;
        encoded.writeUInt32LE(value, 1);
        return encoded;
    }
    const encoded = Buffer.alloc(9);
    encoded[0] = 0xff;
    encoded.writeBigUInt64LE(BigInt(value), 1);
    return encoded;
}

function encodeWitness(items) {
    const buffers = items.map(asBuffer);
    return Buffer.concat([
        encodeCompactSize(buffers.length),
        ...buffers.flatMap((item) => [encodeCompactSize(item.length), item])
    ]);
}

function readCompactSize(buffer, state) {
    if (state.offset >= buffer.length) throw new TypeError('Truncated witness encoding.');
    const marker = buffer[state.offset++];
    if (marker < 0xfd) return marker;

    const bytes = marker === 0xfd ? 2 : marker === 0xfe ? 4 : 8;
    if (state.offset + bytes > buffer.length) throw new TypeError('Truncated witness encoding.');
    let value;
    if (bytes === 2) value = buffer.readUInt16LE(state.offset);
    else if (bytes === 4) value = buffer.readUInt32LE(state.offset);
    else {
        const wide = buffer.readBigUInt64LE(state.offset);
        if (wide > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Witness compact size is too large.');
        value = Number(wide);
    }
    state.offset += bytes;
    if ((bytes === 2 && value < 0xfd) ||
        (bytes === 4 && value <= 0xffff) ||
        (bytes === 8 && value <= 0xffffffff)) {
        throw new TypeError('Non-minimal witness compact size.');
    }
    return value;
}

function decodeWitness(encoded) {
    const buffer = asBuffer(encoded);
    const state = { offset: 0 };
    const count = readCompactSize(buffer, state);
    if (count > MAX_WITNESS_ITEMS) throw new RangeError('Witness stack has too many items.');
    const items = [];
    for (let i = 0; i < count; i++) {
        const length = readCompactSize(buffer, state);
        if (length > MAX_WITNESS_ITEM_SIZE) throw new RangeError('Witness item is too large.');
        if (state.offset + length > buffer.length) throw new TypeError('Truncated witness encoding.');
        items.push(buffer.subarray(state.offset, state.offset + length));
        state.offset += length;
    }
    if (state.offset !== buffer.length) throw new TypeError('Trailing data in witness encoding.');
    return items;
}

function decodeBase64(value) {
    if (typeof value !== 'string' || value.length === 0) throw new TypeError('Signature is required.');
    let encoded = value;
    if (encoded.startsWith(SIMPLE_PREFIX)) encoded = encoded.slice(SIMPLE_PREFIX.length);
    else if (/^(?:ful|pof)/.test(encoded)) throw new TypeError('Signature is not BIP-322 simple format.');
    if (encoded.length === 0 || encoded.length % 4 !== 0 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
        throw new TypeError('Signature is not valid base64.');
    }
    return Buffer.from(encoded, 'base64');
}

function taprootKey(privateKey, publicKey) {
    const fullPublicKey = asBuffer(publicKey);
    const internalKey = fullPublicKey.subarray(1, 33);
    const tweak = asBuffer(bitcoin.crypto.taggedHash('TapTweak', internalKey));
    const hasOddY = fullPublicKey[0] === 0x03 ||
        (fullPublicKey[0] === 0x04 && (fullPublicKey[64] & 1) === 1);
    const evenPrivateKey = hasOddY
        ? asBuffer(ecc.privateNegate(privateKey))
        : asBuffer(privateKey);
    const tweakedPrivateKey = ecc.privateAdd(evenPrivateKey, tweak);
    if (!tweakedPrivateKey) throw new Error('Invalid Taproot key tweak.');
    return { internalKey, privateKey: asBuffer(tweakedPrivateKey) };
}

function signSimple(message, privateKey, publicKey, network, opts = {}) {
    const key = taprootKey(privateKey, publicKey);
    const payment = bitcoin.payments.p2tr({ internalPubkey: key.internalKey, network });
    const { challenge, toSign } = buildTransactions(message, payment.address, network);
    const hash = asBuffer(toSign.hashForWitnessV1(
        0,
        [challenge],
        [0n],
        bitcoin.Transaction.SIGHASH_DEFAULT
    ));
    let auxRand;
    if (opts.auxRand !== undefined) {
        auxRand = asBuffer(opts.auxRand);
        if (auxRand.length !== 32) throw new TypeError('BIP-322 auxiliary randomness must be 32 bytes.');
    }
    const signature = asBuffer(ecc.signSchnorr(hash, key.privateKey, auxRand));
    return {
        address: payment.address,
        signature: SIMPLE_PREFIX + encodeWitness([signature]).toString('base64')
    };
}

function verifySimple(address, message, signature, network) {
    try {
        const witness = decodeWitness(decodeBase64(signature));
        if (witness.length !== 1) return false;
        const encodedSignature = witness[0];
        if (encodedSignature.length !== 64 && encodedSignature.length !== 65) return false;
        const hashType = encodedSignature.length === 64
            ? bitcoin.Transaction.SIGHASH_DEFAULT
            : encodedSignature[64];
        if (hashType !== bitcoin.Transaction.SIGHASH_DEFAULT &&
            hashType !== bitcoin.Transaction.SIGHASH_ALL) return false;
        if (encodedSignature.length === 65 && hashType === bitcoin.Transaction.SIGHASH_DEFAULT) return false;

        const { challenge, toSign } = buildTransactions(message, address, network);
        const hash = asBuffer(toSign.hashForWitnessV1(0, [challenge], [0n], hashType));
        return ecc.verifySchnorr(hash, challenge.subarray(2), encodedSignature.subarray(0, 64));
    } catch (err) {
        return false;
    }
}

module.exports = {
    buildTransactions,
    decodeWitness,
    encodeWitness,
    messageHash,
    signSimple,
    verifySimple
};
