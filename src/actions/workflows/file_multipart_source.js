/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

const SOURCE_TYPES = ['p2pkh', 'p2wpkh', 'p2sh-p2wpkh', 'p2tr'];

// The lane and build mode follow the source type, so a caller-supplied address must
// pick its own type: a P2PKH owner sent down the one-call envelope build is refused by
// the encoder. Types deriveAddress cannot build here (p2tr, segwit off-chain) are skipped.
function sourceTypeOfAddress(sdk, publicKey, address) {
    const match = SOURCE_TYPES.find(type => {
        try { return sdk.wallet.deriveAddress(publicKey, { type }) === address; } catch { return false; }
    });
    if (match) return match;
    const error = new Error('opts.sourceAddress ' + address + ' is not derived from this key as any of '
        + SOURCE_TYPES.join(', ') + '; pass opts.sourceType');
    error.code = 'MULTIPART_SOURCE_MISMATCH';
    throw error;
}

function sourceDetails(sdk, wif, opts, modules) {
    const pair = sdk.wallet.importWIF(wif);
    const net = sdk.wallet.getBitcoinNetwork();
    const taprootChain = net.supportsSegwit !== false;
    const sourceType = opts.sourceType
        || (opts.sourceAddress ? sourceTypeOfAddress(sdk, pair.publicKey, opts.sourceAddress)
            : (taprootChain ? 'p2wpkh' : 'p2pkh'));
    const lane = modules.multipartLaneFor({ taprootChain, sourceType });
    const sourceAddress = opts.sourceAddress || sdk.wallet.deriveAddress(pair.publicKey, { type: sourceType });
    return { ...lane, sourceType, sourceAddress, pubkey: pair.publicKeyHex,
        publicKey: Buffer.from(pair.publicKey) };
}

module.exports = { sourceDetails, sourceTypeOfAddress, SOURCE_TYPES };
