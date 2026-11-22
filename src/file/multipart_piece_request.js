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
 ********************************************************************/

'use strict';

const UTXO_FIELDS = ['txid', 'vout', 'value', 'scriptPubKey'];

function requireRate(rate) {
    if (!Number.isFinite(rate) || rate <= 0) throw new Error('invalid rate');
}

function requireUtxo(utxo) {
    if (!utxo || typeof utxo !== 'object') throw new Error('missing utxo');
    for (const field of UTXO_FIELDS) {
        if (utxo[field] === undefined || utxo[field] === null)
            throw new Error('missing utxo.' + field);
    }
}

const COMPRESSED_KEY = /^0[23][0-9a-fA-F]{64}$/;

function setDefined(into, values) {
    for (const [key, value] of Object.entries(values)) {
        if (value !== undefined) into[key] = value;
    }
    return into;
}

function commonParams({ pubkey, sourceAddress, rate, data, rawData }, encoding) {
    return setDefined({
        encoding,
        compress: false,
        feePerKb: rate * 1000,
        // The encoder RPC takes rawData as a binary string and rebuilds the bytes with
        // Buffer.from(rawData, 'binary'); a Buffer is refused as not a string.
        rawData: Buffer.isBuffer(rawData) || rawData instanceof Uint8Array
            ? Buffer.from(rawData).toString('binary') : rawData,
    }, {
        // The encoder reads `pubkey` as the source: an address passes through, while a
        // bare key resolves to the network default type (P2WPKH on bitcoin), which is the
        // wrong source for a P2PKH owner. The key itself is the TAPROOT internal key.
        pubkey: sourceAddress || pubkey,
        compressedPubKey: COMPRESSED_KEY.test(String(pubkey || '')) ? pubkey : undefined,
        change: sourceAddress,
        data,
    });
}

function commitParams(args, encoding) {
    requireUtxo(args.utxo);
    return setDefined(commonParams(args, encoding), {
        utxos: [args.utxo],
        options: { exactInputs: true },
        sourceAddress: args.sourceAddress,
    });
}

function revealParams(args) {
    if (!args.p2shHash) throw new Error('missing p2shHash');
    if (!args.commitHex) throw new Error('missing commitHex');
    return setDefined(commonParams(args, 'P2SH'), {
        p2shHash: args.p2shHash,
        p2shHex: args.commitHex,
    });
}

function pieceCreateTxParams(args = {}) {
    const { lane, phase, rawData } = args;
    if (lane !== 'envelope' && lane !== 'standard') throw new Error('unknown lane: ' + lane);
    if (lane === 'envelope' && phase !== undefined && phase !== 'commit')
        throw new Error('unknown phase: ' + phase);
    if (lane === 'standard' && phase !== 'commit' && phase !== 'reveal')
        throw new Error('unknown phase: ' + phase);
    requireRate(args.rate);
    if (rawData === undefined || rawData === null) throw new Error('missing rawData');
    if (lane === 'envelope') return commitParams(args, 'TAPROOT');
    return phase === 'commit' ? commitParams(args, 'P2SH') : revealParams(args);
}

module.exports = { pieceCreateTxParams };
