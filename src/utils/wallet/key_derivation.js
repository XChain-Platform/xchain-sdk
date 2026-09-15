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

require('../apply_bufferutils_patch');
const bitcoin = require('bitcoinjs-lib');
const { ECPairFactory } = require('ecpair');
const ecc = require('@bitcoinerlab/secp256k1');
const { getNetwork, getSupportedNetworks, NETWORKS } = require('../../protocol/networks.js');
const { SDKWalletError } = require('../errors.js');

const ECPair = ECPairFactory(ecc);

bitcoin.initEccLib(ecc);

function deriveScriptMultisigAddress(scriptTemplate, scheme, net) {
    if (scheme !== 'p2sh-multisig' && scheme !== 'p2wsh-multisig') {
        throw new SDKWalletError('INVALID_SCHEME',
            'scheme must be one of p2sh-multisig, p2wsh-multisig, taproot-musig2');
    }

    const parts = scriptTemplate.split(':');
    if (parts.length < 4 || parts[0] !== 'multi') {
        throw new SDKWalletError('INVALID_SCRIPT_TEMPLATE',
            'p2sh/p2wsh scriptTemplate must look like "multi:<T>:<pk1>:<pk2>:..."');
    }
    const m = Number(parts[1]);
    if (!Number.isInteger(m) || m <= 0) {
        throw new SDKWalletError('INVALID_SCRIPT_TEMPLATE',
            'threshold (the "<T>" part) must be a positive integer');
    }
    const pubkeyHexes = parts.slice(2);
    if (pubkeyHexes.length < m) {
        throw new SDKWalletError('INVALID_SCRIPT_TEMPLATE',
            'threshold ' + m + ' exceeds cosigner count ' + pubkeyHexes.length);
    }
    const pubkeys = pubkeyHexes.map((h, i) => {
        const b = Buffer.from(h, 'hex');
        if (b.length !== 33) {
            throw new SDKWalletError('INVALID_SCRIPT_TEMPLATE',
                'pubkey[' + i + '] must be 33 bytes compressed (got ' + b.length + ')');
        }
        return b;
    });

    try {
        const redeem = bitcoin.payments.p2ms({ m, pubkeys, network: net });
        if (scheme === 'p2sh-multisig') {
            const p2sh = bitcoin.payments.p2sh({ redeem, network: net });
            return {
                address:       p2sh.address,
                scheme:        'p2sh-multisig',
                redeemScript:  redeem.output ? redeem.output.toString('hex') : null,
                witnessScript: null,
                outputPubkey:  null,
            };
        }
        // p2wsh-multisig
        const p2wsh = bitcoin.payments.p2wsh({ redeem, network: net });
        return {
            address:       p2wsh.address,
            scheme:        'p2wsh-multisig',
            redeemScript:  null,
            witnessScript: redeem.output ? redeem.output.toString('hex') : null,
            outputPubkey:  null,
        };
    } catch (e) {
        throw new SDKWalletError('MULTISIG_DERIVE_FAILED',
            'Failed to derive ' + scheme + ' address: ' + e.message);
    }
}

module.exports = {
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
    },

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
    },

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
    },

    /**
     * Derive a multisig output address from a wallet-side scriptTemplate.
     *
     * Three schemes are supported, matching the MultisigConfig schema
     * in xchain-wallet (§22.4 / §11.3.6):
     *
     *   - 'p2sh-multisig':  scriptTemplate is "multi:<T>:<pk1>:<pk2>:..."
     *                        Redeem script is the standard N-of-M
     *                        OP_CHECKMULTISIG, wrapped in P2SH.
     *   - 'p2wsh-multisig': same template; native segwit witness program.
     *   - 'taproot-musig2': scriptTemplate is "musig2:<aggregatedXOnly>".
     *                        The 32-byte aggregated x-only pubkey is the
     *                        final output pubkey (key-path only, no
     *                        script tree); produces a P2TR bech32m
     *                        address.
     *
     * The scriptTemplate is the source of truth. The wallet computes it
     * once at MultisigConfig creation time (via sdk.musig2.aggregateKeys
     * for taproot-musig2) and persists it; this function only renders.
     *
     * @param {object} params
     * @param {string} params.scriptTemplate
     * @param {'p2sh-multisig' | 'p2wsh-multisig' | 'taproot-musig2'} params.scheme
     * @param {string} [params.network]   override the SDK instance's network
     * @returns {{ address: string, scheme: string, redeemScript: string | null, witnessScript: string | null, outputPubkey: string | null }}
     */
    deriveMultisigAddress(params) {
        if (!params || typeof params !== 'object')
            throw new SDKWalletError('INVALID_INPUT', 'deriveMultisigAddress params required');
        if (typeof params.scriptTemplate !== 'string' || params.scriptTemplate.length === 0)
            throw new SDKWalletError('INVALID_INPUT', 'scriptTemplate must be a non-empty string');

        const net = this._resolveNet(params.network);
        const scheme = params.scheme;

        if (scheme === 'taproot-musig2') {
            const m = /^musig2:([0-9a-fA-F]+)$/.exec(params.scriptTemplate);
            if (!m) {
                throw new SDKWalletError('INVALID_SCRIPT_TEMPLATE',
                    'taproot-musig2 scriptTemplate must look like "musig2:<aggregatedXOnly hex>"');
            }
            const aggXOnly = Buffer.from(m[1], 'hex');
            if (aggXOnly.length !== 32) {
                throw new SDKWalletError('INVALID_SCRIPT_TEMPLATE',
                    'aggregated x-only pubkey must be 32 bytes (got ' + aggXOnly.length + ')');
            }
            try {
                const p2tr = bitcoin.payments.p2tr({ pubkey: aggXOnly, network: net });
                return {
                    address:       p2tr.address,
                    scheme:        'taproot-musig2',
                    redeemScript:  null,
                    witnessScript: null,
                    outputPubkey:  m[1].toLowerCase(),
                };
            } catch (e) {
                throw new SDKWalletError('P2TR_FAILED',
                    'Failed to derive P2TR address: ' + e.message);
            }
        }

        return deriveScriptMultisigAddress(params.scriptTemplate, scheme, net);
    },

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
                    // fromBech32 (bitcoinjs 6.x) enforces BIP-350: v0 must be
                    // bech32, v1+ must be bech32m, else it throws (caught below).
                    const decoded = bitcoin.address.fromBech32(address);
                    if (decoded.prefix === params.bech32) {
                        // Classify by witness version + program length (BIP-141/350),
                        // not by length alone. A Taproot address (v1, 32-byte program)
                        // must not be mislabeled p2wsh, and no non-standard
                        // version/length combination may be blessed as generically valid.
                        if (decoded.version === 0 && decoded.data.length === 20) {
                            return { valid: true, type: 'p2wpkh', network: name, error: null };
                        }
                        if (decoded.version === 0 && decoded.data.length === 32) {
                            return { valid: true, type: 'p2wsh', network: name, error: null };
                        }
                        if (decoded.version === 1 && decoded.data.length === 32) {
                            return { valid: true, type: 'p2tr', network: name, error: null };
                        }
                        return {
                            valid: false, type: null, network: null,
                            error: `Unsupported witness program (version ${decoded.version}, ${decoded.data.length}-byte program).`
                        };
                    }
                } catch (e) { /* not bech32 for this network */ }
            }
        }

        return { valid: false, type: null, network: null, error: 'Address does not match any supported network.' };
    },
};

Object.defineProperty(module.exports, 'ECPair', { value: ECPair });
