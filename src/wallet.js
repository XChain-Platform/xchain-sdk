/*********************************************************************
 *
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 *
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided "AS IS", without warranties or conditions of any kind.
 *
 **********************************************************************
 *
 * XChain Platform SDK - Wallet Utilities
 *
 * Key management, address validation, PSBT signing, broadcast, UTXOs.
 *
 ********************************************************************/

const bitcoin = require('bitcoinjs-lib');
const { ECPairFactory } = require('ecpair');
const ecc = require('@bitcoinerlab/secp256k1');
const { getNetwork, getSupportedNetworks, NETWORKS } = require('./networks.js');
const { SDKWalletError } = require('./errors.js');

const ECPair = ECPairFactory(ecc);

// Initialize bitcoinjs-lib with the ecc library
bitcoin.initEccLib(ecc);


class WalletUtils {

    constructor(network) {
        this.network = network || null;
        this._netParams = network ? getNetwork(network) : null;
    }

    // Resolve network params — instance default or per-call override
    _resolveNet(network) {
        if (network) return getNetwork(network);
        if (this._netParams) return this._netParams;
        throw new SDKWalletError('NETWORK_NOT_CONFIGURED',
            'Network not configured. Provide network in SDK options or pass it to this method.');
    }

    // -------------------------------------------------------------------------
    //  Key utilities
    // -------------------------------------------------------------------------

    /**
     * Import a WIF-encoded private key.
     *
     * @param {string} wif
     * @returns {{ wif: string, privateKey: Buffer, publicKey: Buffer, publicKeyHex: string, compressed: boolean }}
     */
    importWIF(wif) {
        if (!wif || typeof wif !== 'string') {
            throw new SDKWalletError('INVALID_WIF', 'WIF string is required.');
        }

        const net = this._resolveNet();
        let keyPair;

        try {
            keyPair = ECPair.fromWIF(wif, net);
        } catch (err) {
            // Try decoding without network restriction to detect mismatch
            try {
                const allNets = getSupportedNetworks().map(n => getNetwork(n));
                ECPair.fromWIF(wif, allNets);
                throw new SDKWalletError('NETWORK_MISMATCH',
                    `WIF key does not match configured network "${this.network}".`);
            } catch (innerErr) {
                if (innerErr.name === 'SDKWalletError') throw innerErr;
                throw new SDKWalletError('INVALID_WIF', `Failed to import WIF: ${err.message}`);
            }
        }

        return {
            wif: keyPair.toWIF(),
            privateKey: keyPair.privateKey,
            publicKey: keyPair.publicKey,
            publicKeyHex: keyPair.publicKey.toString('hex'),
            compressed: keyPair.compressed
        };
    }

    /**
     * Generate a new random keypair.
     *
     * @param {Object} [opts]
     * @param {boolean} [opts.compressed=true]
     * @returns {{ wif: string, privateKey: Buffer, publicKey: Buffer, publicKeyHex: string, compressed: boolean }}
     */
    generateKeyPair(opts = {}) {
        const net = this._resolveNet();
        const compressed = opts.compressed !== false;

        const keyPair = ECPair.makeRandom({ network: net, compressed: compressed });

        return {
            wif: keyPair.toWIF(),
            privateKey: keyPair.privateKey,
            publicKey: keyPair.publicKey,
            publicKeyHex: keyPair.publicKey.toString('hex'),
            compressed: keyPair.compressed
        };
    }

    // -------------------------------------------------------------------------
    //  Address derivation & validation
    // -------------------------------------------------------------------------

    /**
     * Derive an address from a public key (Buffer or hex string).
     *
     * @param {Buffer|string} publicKey
     * @param {Object} [opts]
     * @param {'p2pkh'|'p2wpkh'|'p2sh-p2wpkh'} [opts.type='p2pkh']
     * @returns {string}
     */
    deriveAddress(publicKey, opts = {}) {
        const net = this._resolveNet();
        const type = opts.type || 'p2pkh';

        let pubKeyBuf;
        if (typeof publicKey === 'string') {
            pubKeyBuf = Buffer.from(publicKey, 'hex');
        } else if (Buffer.isBuffer(publicKey)) {
            pubKeyBuf = publicKey;
        } else {
            throw new SDKWalletError('INVALID_PUBLIC_KEY', 'Public key must be a Buffer or hex string.');
        }

        if (pubKeyBuf.length !== 33 && pubKeyBuf.length !== 65) {
            throw new SDKWalletError('INVALID_PUBLIC_KEY',
                `Invalid public key length: ${pubKeyBuf.length}. Expected 33 (compressed) or 65 (uncompressed).`);
        }

        if ((type === 'p2wpkh' || type === 'p2sh-p2wpkh') && !net.supportsSegwit) {
            throw new SDKWalletError('SEGWIT_NOT_SUPPORTED',
                `SegWit addresses are not supported on ${this.network}.`);
        }

        try {
            switch (type) {
                case 'p2pkh':
                    return bitcoin.payments.p2pkh({ pubkey: pubKeyBuf, network: net }).address;
                case 'p2wpkh':
                    return bitcoin.payments.p2wpkh({ pubkey: pubKeyBuf, network: net }).address;
                case 'p2sh-p2wpkh':
                    return bitcoin.payments.p2sh({
                        redeem: bitcoin.payments.p2wpkh({ pubkey: pubKeyBuf, network: net }),
                        network: net
                    }).address;
                default:
                    throw new SDKWalletError('INVALID_ADDRESS_TYPE',
                        `Unknown address type: "${type}". Supported: p2pkh, p2wpkh, p2sh-p2wpkh`);
            }
        } catch (err) {
            if (err.name === 'SDKWalletError') throw err;
            throw new SDKWalletError('INVALID_PUBLIC_KEY', `Failed to derive address: ${err.message}`);
        }
    }

    /**
     * Validate a coin address for the configured (or specified) network.
     *
     * @param {string} address
     * @param {string} [network] - Override instance network
     * @returns {{ valid: boolean, type: string|null, network: string|null, error: string|null }}
     */
    validateAddress(address, network) {
        if (!address || typeof address !== 'string') {
            return { valid: false, type: null, network: null, error: 'Address must be a non-empty string.' };
        }

        // If a specific network is given, only check that one
        const networksToCheck = network
            ? [{ name: network, params: getNetwork(network) }]
            : this.network
                ? [{ name: this.network, params: this._netParams }]
                : getSupportedNetworks().map(n => ({ name: n, params: getNetwork(n) }));

        for (const { name, params } of networksToCheck) {
            // Try P2PKH / P2SH (base58check)
            try {
                const decoded = bitcoin.address.fromBase58Check(address);
                if (decoded.version === params.pubKeyHash) {
                    return { valid: true, type: 'p2pkh', network: name, error: null };
                }
                if (decoded.version === params.scriptHash) {
                    return { valid: true, type: 'p2sh', network: name, error: null };
                }
            } catch (e) { /* not base58 for this network */ }

            // Try bech32 (P2WPKH / P2WSH)
            if (params.bech32) {
                try {
                    const decoded = bitcoin.address.fromBech32(address);
                    if (decoded.prefix === params.bech32) {
                        if (decoded.data.length === 20) {
                            return { valid: true, type: 'p2wpkh', network: name, error: null };
                        }
                        if (decoded.data.length === 32) {
                            return { valid: true, type: 'p2wsh', network: name, error: null };
                        }
                        return { valid: true, type: 'bech32', network: name, error: null };
                    }
                } catch (e) { /* not bech32 for this network */ }
            }
        }

        return { valid: false, type: null, network: null, error: 'Address does not match any supported network.' };
    }

    // -------------------------------------------------------------------------
    //  PSBT signing
    // -------------------------------------------------------------------------

    /**
     * Sign an unsigned PSBT hex string with a WIF private key.
     * Finalizes all inputs after signing.
     *
     * @param {string} psbtHex - Unsigned PSBT from encoder, as hex
     * @param {string} wif - WIF-encoded private key
     * @returns {{ txHex: string, txid: string, psbtHex: string }}
     */
    signPsbt(psbtHex, wif) {
        if (!psbtHex || typeof psbtHex !== 'string') {
            throw new SDKWalletError('INVALID_PSBT', 'PSBT hex string is required.');
        }
        if (!wif || typeof wif !== 'string') {
            throw new SDKWalletError('INVALID_WIF', 'WIF private key is required.');
        }

        const net = this._resolveNet();
        let keyPair;

        try {
            keyPair = ECPair.fromWIF(wif, net);
        } catch (err) {
            throw new SDKWalletError('INVALID_WIF', `Failed to import WIF: ${err.message}`);
        }

        let psbt;
        try {
            psbt = bitcoin.Psbt.fromHex(psbtHex, { network: net });
        } catch (err) {
            throw new SDKWalletError('INVALID_PSBT', `Failed to parse PSBT: ${err.message}`);
        }

        // Sign all inputs
        try {
            psbt.signAllInputs(keyPair);
        } catch (err) {
            throw new SDKWalletError('SIGN_FAILED', `PSBT signing failed: ${err.message}`);
        }

        // Finalize all inputs
        try {
            psbt.finalizeAllInputs();
        } catch (err) {
            throw new SDKWalletError('FINALIZE_FAILED', `PSBT finalization failed: ${err.message}`);
        }

        const tx = psbt.extractTransaction();

        return {
            txHex: tx.toHex(),
            txid: tx.getId(),
            psbtHex: psbt.toHex()
        };
    }

    // -------------------------------------------------------------------------
    //  Transaction broadcasting (async — goes through encoder)
    // -------------------------------------------------------------------------

    /**
     * Broadcast a signed raw transaction hex to the coin node via the encoder.
     *
     * @param {string} txHex - Signed raw transaction hex (from signPsbt)
     * @param {Object} encoder - EncoderClient instance (injected by SDK convenience method)
     * @returns {Promise<{ txid: string }>}
     */
    async broadcastTx(txHex, encoder) {
        if (!txHex || typeof txHex !== 'string') {
            throw new SDKWalletError('INVALID_TX_HEX', 'Signed transaction hex is required.');
        }
        if (!encoder) {
            throw new SDKWalletError('ENCODER_REQUIRED',
                'Encoder client is required for broadcasting. Use sdk.broadcastTx() instead of sdk.wallet.broadcastTx().');
        }

        try {
            return await encoder.broadcastTx(txHex);
        } catch (err) {
            if (err.name && err.name.startsWith('SDK')) throw err;
            throw new SDKWalletError('BROADCAST_FAILED', `Transaction broadcast failed: ${err.message}`);
        }
    }

    // -------------------------------------------------------------------------
    //  UTXO queries (async — goes through encoder)
    // -------------------------------------------------------------------------

    /**
     * Fetch UTXOs for an address from the UTXO tracker via the encoder.
     *
     * @param {string} address
     * @param {Object} encoder - EncoderClient instance (injected by SDK convenience method)
     * @returns {Promise<Array>}
     */
    async getUTXOs(address, encoder) {
        if (!address || typeof address !== 'string') {
            throw new SDKWalletError('INVALID_ADDRESS', 'Address is required for UTXO query.');
        }
        if (!encoder) {
            throw new SDKWalletError('ENCODER_REQUIRED',
                'Encoder client is required for UTXO queries. Use sdk.getUTXOs() instead of sdk.wallet.getUTXOs().');
        }

        try {
            const result = await encoder.getUTXOs(address);
            return result.utxos || result;
        } catch (err) {
            if (err.name && err.name.startsWith('SDK')) throw err;
            throw new SDKWalletError('UTXO_FETCH_FAILED', `UTXO fetch failed: ${err.message}`);
        }
    }
}

module.exports = WalletUtils;
