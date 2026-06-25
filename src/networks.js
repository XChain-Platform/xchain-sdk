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
 * bitcoinjs-lib compatible network objects, generated from the canonical coin
 * registry (src/coins) so the SDK can never drift from the rest of the platform.
 * The SDK exposes a lean shape (no relay-only fields); supportsSegwit is derived
 * (true unless the coin marks it false). Frozen on build to prevent mutation.
 *
 ********************************************************************/

const coins = require('./coins');

const NETWORKS = {};
for(const tick of coins.ALLOWED_COINS){
    for(const network of coins.NETWORKS){
        const n = coins.getCoinConfig(tick, network).net;
        const obj = { messagePrefix: n.messagePrefix };
        if(n.bech32) obj.bech32 = n.bech32;
        obj.bip32          = { public: n.bip32.public, private: n.bip32.private };
        obj.pubKeyHash     = n.pubKeyHash;
        obj.scriptHash     = n.scriptHash;
        obj.wif            = n.wif;
        obj.dustThreshold  = n.dustThreshold;
        obj.supportsSegwit = (n.supportsSegwit === false) ? false : true;
        NETWORKS[coins.COIN_FULL_NAME[tick] + '-' + network] = obj;
    }
}

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
