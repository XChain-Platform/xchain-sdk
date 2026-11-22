/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * ECPair v3 network-shape compatibility.
 *
 ********************************************************************/

const { ECPairFactory } = require('ecpair');

// ECPair v3 requires a bech32 string even for networks without SegWit.
// Keep the public network object honest and supply its empty sentinel here.
function compatibleNetwork(network) {
    if (!network || typeof network.bech32 === 'string') return network;
    return Object.assign({}, network, { bech32: '' });
}

function compatibleOptions(options) {
    if (!options || !options.network) return options;
    return Object.assign({}, options, { network: compatibleNetwork(options.network) });
}

// ECPair v3 returns plain Uint8Array values. Keep the SDK's Buffer-facing API
// while still satisfying bitcoinjs-lib's Uint8Array signer interface.
function compatiblePair(pair) {
    return {
        get publicKey() { return Buffer.from(pair.publicKey); },
        get privateKey() {
            return pair.privateKey === undefined ? undefined : Buffer.from(pair.privateKey);
        },
        get compressed() { return pair.compressed; },
        get network() { return pair.network; },
        get lowR() { return pair.lowR; },
        set lowR(value) { pair.lowR = value; },
        toWIF() { return pair.toWIF(); },
        tweak(value) { return compatiblePair(pair.tweak(value)); },
        sign(hash, lowR) { return Buffer.from(pair.sign(hash, lowR)); },
        signSchnorr(hash) { return Buffer.from(pair.signSchnorr(hash)); },
        verify(hash, signature) { return pair.verify(hash, signature); },
        verifySchnorr(hash, signature) { return pair.verifySchnorr(hash, signature); },
    };
}

function createECPair(ecc) {
    const api = ECPairFactory(ecc);
    return Object.assign({}, api, {
        fromPrivateKey(key, options) {
            return compatiblePair(api.fromPrivateKey(key, compatibleOptions(options)));
        },
        fromPublicKey(key, options) {
            return compatiblePair(api.fromPublicKey(key, compatibleOptions(options)));
        },
        fromWIF(wif, network) {
            const compatible = Array.isArray(network)
                ? network.map(compatibleNetwork)
                : compatibleNetwork(network);
            return compatiblePair(api.fromWIF(wif, compatible));
        },
        makeRandom(options) {
            return compatiblePair(api.makeRandom(compatibleOptions(options)));
        },
    });
}

module.exports = { createECPair, compatibleNetwork };
