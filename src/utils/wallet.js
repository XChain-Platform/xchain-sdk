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
 * XChain Platform SDK - Wallet Utilities
 *
 * Key management, address validation, PSBT signing, broadcast, UTXOs.
 *
 ********************************************************************/

// Must load before any PSBT is parsed or signed: teaches bitcoinjs-lib and
// bip174 to carry satoshi values above 2^53-1 as BigInt, so a PSBT the
// encoder built around a >2^53-1-sat DOGE output can be signed, finalized,
// and extracted here (mirrors xchain-encoder/src/build/apply_bufferutils_patch.js).
require('./apply_bufferutils_patch');
const { getNetwork } = require('../protocol/networks.js');
const { SDKWalletError } = require('./errors.js');
const { installMethods } = require('./install_methods.js');

class WalletUtils {

    constructor(network) {
        this.network = network || null;
        this._netParams = network ? getNetwork(network) : null;
    }

    resolveNet(network) {
        if (network) return getNetwork(network);
        if (this._netParams) return this._netParams;
        throw new SDKWalletError('NETWORK_NOT_CONFIGURED',
            'Network not configured. Provide network in SDK options or pass it to this method.');
    }

    // Public accessor for the bitcoinjs-lib network params this SDK is
    // configured for (null when constructed without a network). Consumers that
    // build taproot scripts / addresses off the SDK (e.g. the wallet's
    // co-signer provisioning deriving a MuSig2 aggregate address) read this
    // instead of duplicating the coin-registry-derived params. Pass a network
    // string to resolve a different network's params without a second SDK.
    getBitcoinNetwork(network) {
        if (network) return getNetwork(network);
        return this._netParams;
    }
}

installMethods(WalletUtils.prototype, require('./wallet/key_derivation.js'), require('./wallet/multisig_signing.js'), require('./wallet/psbt_signing.js'), require('./wallet/psbt_inspection.js'));

module.exports = WalletUtils;
