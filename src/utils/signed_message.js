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
 * XChain Platform SDK - Bitcoin Signed Message Utilities
 *
 ********************************************************************/

const bitcoin = require('bitcoinjs-lib');
const ecc = require('@bitcoinerlab/secp256k1');

const DEFAULT_PREFIX = Buffer.from('\x18Bitcoin Signed Message:\n', 'utf8');
const P2WPKH = 'p2wpkh';
const P2SH_P2WPKH = 'p2sh(p2wpkh)';

function encodeVarInt(value) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid varint value');
    if (value < 0xfd) return Buffer.from([value]);
    if (value <= 0xffff) {
        const result = Buffer.allocUnsafe(3);
        result[0] = 0xfd;
        result.writeUInt16LE(value, 1);
        return result;
    }
    if (value <= 0xffffffff) {
        const result = Buffer.allocUnsafe(5);
        result[0] = 0xfe;
        result.writeUInt32LE(value, 1);
        return result;
    }
    const result = Buffer.allocUnsafe(9);
    result[0] = 0xff;
    result.writeBigUInt64LE(BigInt(value), 1);
    return result;
}

function magicHash(message, messagePrefix) {
    let prefix = messagePrefix || DEFAULT_PREFIX;
    if (!Buffer.isBuffer(prefix)) prefix = Buffer.from(prefix, 'utf8');
    const messageBytes = Buffer.isBuffer(message) ? message : Buffer.from(message, 'utf8');

    // Network prefixes include their own CompactSize length byte by convention.
    const payload = Buffer.concat([prefix, encodeVarInt(messageBytes.length), messageBytes]);
    return Buffer.from(bitcoin.crypto.hash256(payload));
}

function normalizeSegwitType(segwitType) {
    if (typeof segwitType === 'string' || segwitType instanceof String) {
        segwitType = segwitType.toLowerCase();
    }
    if (segwitType && segwitType !== P2WPKH && segwitType !== P2SH_P2WPKH) {
        throw new Error(`Unrecognized segwitType: use "${P2SH_P2WPKH}" or "${P2WPKH}"`);
    }
    return segwitType;
}

function encodeSignature(signature, recoveryId, compressed, segwitType) {
    let flag = recoveryId;
    if (segwitType) {
        flag += 8;
        if (segwitType === P2WPKH) flag += 4;
    } else if (compressed) {
        flag += 4;
    }
    return Buffer.concat([Buffer.from([flag + 27]), Buffer.from(signature)]);
}

function decodeSignature(signature) {
    if (signature.length !== 65) throw new Error('Invalid signature length');
    const flag = signature[0] - 27;
    if (flag < 0 || flag > 15) throw new Error('Invalid signature parameter');
    return {
        compressed: !!(flag & 12),
        segwitType: !(flag & 8) ? null : ((flag & 4) ? P2WPKH : P2SH_P2WPKH),
        recoveryId: flag & 3,
        signature: signature.subarray(1)
    };
}

function sign(message, privateKey, compressed, messagePrefix, options) {
    if (typeof messagePrefix === 'object' && options === undefined && !Buffer.isBuffer(messagePrefix)) {
        options = messagePrefix;
        messagePrefix = undefined;
    }
    const segwitType = normalizeSegwitType(options && options.segwitType);
    const extraEntropy = options && options.extraEntropy;
    const hash = magicHash(message, messagePrefix);
    const signed = ecc.signRecoverable(hash, privateKey, extraEntropy);
    return encodeSignature(signed.signature, signed.recoveryId, compressed, segwitType);
}

function segwitRedeemHash(publicKeyHash) {
    return bitcoin.crypto.hash160(Buffer.concat([Buffer.from('0014', 'hex'), publicKeyHash]));
}

function base58Hash(address) {
    return bitcoin.address.fromBase58Check(address).hash;
}

function bech32Hash(address) {
    return bitcoin.address.fromBech32(address).data;
}

function equalBytes(left, right) {
    return Buffer.from(left).equals(Buffer.from(right));
}

function checkAllAddressTypes(address, publicKeyHash) {
    try {
        return equalBytes(publicKeyHash, bech32Hash(address));
    } catch (err) {
        const expected = base58Hash(address);
        return equalBytes(publicKeyHash, expected) ||
            equalBytes(segwitRedeemHash(publicKeyHash), expected);
    }
}

function verify(message, address, signature, messagePrefix, checkSegwitAlways) {
    const signatureBytes = Buffer.isBuffer(signature) ? signature : Buffer.from(signature, 'base64');
    const parsed = decodeSignature(signatureBytes);
    if (checkSegwitAlways && !parsed.compressed) {
        throw new Error('checkSegwitAlways can only be used with a compressed pubkey signature flagbyte');
    }

    const hash = magicHash(message, messagePrefix);
    const publicKey = Buffer.from(ecc.recover(
        hash, parsed.signature, parsed.recoveryId, parsed.compressed
    ));
    const publicKeyHash = bitcoin.crypto.hash160(publicKey);

    if (parsed.segwitType === P2SH_P2WPKH) {
        return equalBytes(segwitRedeemHash(publicKeyHash), base58Hash(address));
    }
    if (parsed.segwitType === P2WPKH) {
        return equalBytes(publicKeyHash, bech32Hash(address));
    }
    if (checkSegwitAlways) return checkAllAddressTypes(address, publicKeyHash);
    return equalBytes(publicKeyHash, base58Hash(address));
}

module.exports = { magicHash, sign, verify };
