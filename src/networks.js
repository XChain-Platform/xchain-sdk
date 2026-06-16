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
 * XChain Platform SDK - Network Parameters
 *
 * bitcoinjs-lib compatible network objects for all supported chains.
 * Ported from xchain-encoder/src/CryptoNetworks.js — kept in the SDK
 * so there is no cross-package dependency.
 *
 ********************************************************************/

const NETWORKS = {
    'bitcoin-mainnet': {
        messagePrefix: '\x18Bitcoin Signed Message:\n',
        bech32: 'bc',
        bip32: { public: 0x0488b21e, private: 0x0488ade4 },
        pubKeyHash: 0x00,
        scriptHash: 0x05,
        wif: 0x80,
        dustThreshold: 546,
        supportsSegwit: true
    },
    'bitcoin-testnet': {
        messagePrefix: '\x18Bitcoin Signed Message:\n',
        bech32: 'tb',
        bip32: { public: 0x043587cf, private: 0x04358394 },
        pubKeyHash: 0x6f,
        scriptHash: 0xc4,
        wif: 0xef,
        dustThreshold: 546,
        supportsSegwit: true
    },
    'bitcoin-regtest': {
        messagePrefix: '\x18Bitcoin Signed Message:\n',
        bech32: 'bcrt',
        bip32: { public: 0x043587cf, private: 0x04358394 },
        pubKeyHash: 0x6f,
        scriptHash: 0xc4,
        wif: 0xef,
        dustThreshold: 546,
        supportsSegwit: true
    },
    'litecoin-mainnet': {
        messagePrefix: '\x19Litecoin Signed Message:\n',
        bech32: 'ltc',
        bip32: { public: 0x019da462, private: 0x019d9cfe },
        pubKeyHash: 0x30,
        scriptHash: 0x32,
        wif: 0xb0,
        dustThreshold: 5460,
        supportsSegwit: true
    },
    'litecoin-testnet': {
        messagePrefix: '\x19Litecoin Signed Message:\n',
        bech32: 'tltc',
        bip32: { public: 0x0436f6e1, private: 0x0436ef7d },
        pubKeyHash: 0x6f,
        scriptHash: 0xc4,
        wif: 0xef,
        dustThreshold: 5460,
        supportsSegwit: true
    },
    'litecoin-regtest': {
        messagePrefix: '\x19Litecoin Signed Message:\n',
        bech32: 'rltc',
        bip32: { public: 0x0436f6e1, private: 0x0436ef7d },
        pubKeyHash: 0x6f,
        scriptHash: 0xc4,
        wif: 0xef,
        dustThreshold: 5460,
        supportsSegwit: true
    },
    'dogecoin-mainnet': {
        messagePrefix: '\x19Dogecoin Signed Message:\n',
        bip32: { public: 0x02facafd, private: 0x02fac398 },
        pubKeyHash: 0x1e,
        scriptHash: 0x16,
        wif: 0x9e,
        dustThreshold: 100000,
        supportsSegwit: false
    },
    'dogecoin-testnet': {
        messagePrefix: '\x19Dogecoin Signed Message:\n',
        bip32: { public: 0x0432a9a8, private: 0x0432a243 },
        pubKeyHash: 0x71,
        scriptHash: 0xc4,
        wif: 0xf1,
        dustThreshold: 100000,
        supportsSegwit: false
    },
    'dogecoin-regtest': {
        messagePrefix: '\x19Dogecoin Signed Message:\n',
        bip32: { public: 0x0432a9a8, private: 0x0432a243 },
        // Dogecoin Core in regtest mode uses Bitcoin-testnet base58 prefixes,
        // not Dogecoin-testnet's. Matches the same fix in xchain-utxo-tracker,
        // xchain-decoder, xchain-encoder, xchain-e2e-test CryptoNetworks.
        pubKeyHash: 0x6f,
        scriptHash: 0xc4,
        wif: 0xef,
        dustThreshold: 100000,
        supportsSegwit: false
    }
};

// Freeze all network objects to prevent mutation
for (const key of Object.keys(NETWORKS)) {
    Object.freeze(NETWORKS[key].bip32);
    Object.freeze(NETWORKS[key]);
}
Object.freeze(NETWORKS);

function getNetwork(networkString) {
    const net = NETWORKS[networkString];
    if (!net) {
        const supported = Object.keys(NETWORKS).join(', ');
        throw new Error(`Unknown network: "${networkString}". Supported: ${supported}`);
    }
    return net;
}

function getSupportedNetworks() {
    return Object.keys(NETWORKS);
}

module.exports = { getNetwork, getSupportedNetworks, NETWORKS };
