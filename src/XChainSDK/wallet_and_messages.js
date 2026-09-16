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
 * XChain Platform SDK - XChainSDK (Software Development Kit)
 *
 * This file handles parsing XChain Platform SDK requests
 *
 ********************************************************************/

const ExplorerClient = require('../clients/explorer.js');
const config = require('../config.js');
const { SDKConfigError } = require('../utils/errors.js');

// Keep wallet and messaging delegates together so account-facing operations stay grouped.
module.exports = {


    /*
     *  Wallet Convenience Methods
     */

    signPsbt(psbtHex, wif)              { return this.wallet.signPsbt(psbtHex, wif); },
    decomposePsbt(psbtHex)              { return this.wallet.decomposePsbt(psbtHex); },
    txidOf(txHex)                       { return this.wallet.txidOf(txHex); },
    async broadcastTx(txHex)            { return this.wallet.broadcastTx(txHex, this._requireEncoder()); },
    async getUTXOs(address)             { return this.wallet.getUTXOs(address, this._requireEncoder()); },
    validateAddress(address, network)   { return this.wallet.validateAddress(address, network); },
    importWIF(wif)                      { return this.wallet.importWIF(wif); },
    generateKeyPair(opts)               { return this.wallet.generateKeyPair(opts); },
    deriveAddress(publicKey, opts)      { return this.wallet.deriveAddress(publicKey, opts); },
    deriveMultisigAddress(params)       { return this.wallet.deriveMultisigAddress(params); },


    /*
     *  Auth Convenience Methods
     */

    generateChallenge(address, opts)                      { return this.auth.generateChallenge(address, opts); },
    signMessage(message, wif, opts)                       { return this.auth.signMessage(message, wif, opts); },
    verifyOwnership(address, message, signature, network) { return this.auth.verifyOwnership(address, message, signature, network); },
    verifyMessage(address, message, signature, network)   { return this.auth.verifyMessage(address, message, signature, network); },


    /*
     *  Messaging Convenience Methods
     */

    async sendMessage(params) { return this.messaging.send(params, this); },
    async getPublicKey(address) { return this.messaging.getPublicKey(address, this._requireExplorer()); },
    async getMessagesForAddress(address, opts) { return this.messaging.getMessages(address, opts, this._requireExplorer()); },

    /*
     *  Token-gated content (FILE with GATE_TICKER set).
     *  See xchain-documentation/protocol/token-gated-content.md.
     */

    // Fetch the raw ciphertext bytes for a gated FILE by ACTION_INDEX.
    async getGatedFileRaw(actionIndex, coin = null) { return this._requireExplorer().getGatedFileRaw(actionIndex, coin); },

    // Absolute URL of a FILE action's raw bytes on the configured explorer:
    // the resolution target for TIS data_ref entries and on-chain TIS docs.
    fileRawUrl(actionIndex, coin = null) { return this._requireExplorer().fileRawUrl(actionIndex, coin); },

    /**
     * Fetch messages for an address across all chains (BTC, LTC, DOGE).
     * Creates explorer clients for each chain using the same server URL
     * and queries them in parallel.
     */
    async getAllMessagesForAddress(address, opts) {
        let explorer = this._requireExplorer();
        let network = this.options.network || config.env.network();
        // Messages are looked up per network, so without one we would not know which chain to ask.
        if (!network) throw new SDKConfigError('NETWORK_NOT_CONFIGURED', 'Network is required for cross-chain message queries.');

        let tier = network.split('-')[1]; // 'mainnet', 'testnet', or 'regtest'
        let chains = [
            { network: 'bitcoin-' + tier,  chain: 'BTC' },
            { network: 'litecoin-' + tier,  chain: 'LTC' },
            { network: 'dogecoin-' + tier,  chain: 'DOGE' }
        ];

        let explorers = chains.map(({ network: net, chain }) => {
            let client = new ExplorerClient({
                network:      net,
                explorerUrl:  explorer.baseUrl,
                explorerPort: explorer.port,
                timeout:      explorer.timeout,
                retry:        explorer.retry,
                hooks:        explorer.hooks
            });
            return { explorer: client, chain };
        });

        return this.messaging.getAllMessages(address, opts, explorers);
    },
};
