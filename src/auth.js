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
 * XChain Platform SDK - Auth Utilities
 *
 * Challenge-response wallet ownership verification.
 * signMessage and verifyMessage work with any arbitrary string.
 * Sites can generate their own messages and verify independently
 * of this SDK.
 *
 ********************************************************************/

const crypto = require('crypto');
const bitcoinMessage = require('bitcoinjs-message');
const { ECPairFactory } = require('ecpair');
const ecc = require('@bitcoinerlab/secp256k1');
const { getNetwork } = require('./networks.js');
const { SDKAuthError } = require('./errors.js');

const ECPair = ECPairFactory(ecc);


class AuthUtils {

    constructor(network) {
        this.network = network || null;
        this._netParams = network ? getNetwork(network) : null;
    }

    // Resolve network params: instance default or per-call override
    _resolveNet(network) {
        if (network) return getNetwork(network);
        if (this._netParams) return this._netParams;
        throw new SDKAuthError('NETWORK_NOT_CONFIGURED',
            'Network not configured. Provide network in SDK options or pass it to this method.');
    }

    /**
     * Generate a challenge for the user to sign.
     *
     * If opts.message is provided, it is used as-is (custom site message).
     * Otherwise a default structured message is generated including the address.
     *
     * Stateless: the caller stores the nonce and enforces expiry/single-use.
     *
     * @param {string} address - The address being verified
     * @param {Object} [opts]
     * @param {string} [opts.appId='XChain'] - Application identifier
     * @param {string} [opts.nonce] - Override auto-generated nonce (hex)
     * @param {string} [opts.message] - Custom message to use instead of default
     * @param {number} [opts.expiresInMs=300000] - Expiry window in ms (default 5 min)
     * @returns {{ challenge: string, nonce: string, timestamp: string, expiresAt: string }}
     */
    generateChallenge(address, opts = {}) {
        if (!address || typeof address !== 'string') {
            throw new SDKAuthError('INVALID_ADDRESS', 'Address is required for challenge generation.');
        }

        const nonce = opts.nonce || crypto.randomBytes(32).toString('hex');
        const timestamp = new Date().toISOString();
        const expiresInMs = opts.expiresInMs || 300000;
        const expiresAt = new Date(Date.now() + expiresInMs).toISOString();

        let challenge;
        if (opts.message) {
            // Custom message: use as-is
            challenge = opts.message;
        } else {
            // Default structured message
            const appId = opts.appId || 'XChain';
            challenge = `XChain wallet verification\nApp: ${appId}\nAddress: ${address}\nNonce: ${nonce}\nTimestamp: ${timestamp}`;
        }

        return { challenge, nonce, timestamp, expiresAt };
    }

    /**
     * Sign a message with a WIF private key using Bitcoin message signing.
     * Works with any string: a challenge from generateChallenge, a custom
     * site message, or anything else.
     *
     * @param {string} message - The message to sign
     * @param {string} wif - WIF-encoded private key
     * @param {Object} [opts]
     * @param {boolean} [opts.segwitRedeemScript=false] - For P2SH-P2WPKH addresses
     * @param {boolean} [opts.segwitNative=false] - For P2WPKH (bech32) addresses
     * @param {string} [opts.network] - Override instance network
     * @returns {{ signature: string, address: string }}
     */
    signMessage(message, wif, opts = {}) {
        if (!message || typeof message !== 'string') {
            throw new SDKAuthError('INVALID_MESSAGE', 'Message is required for signing.');
        }
        if (!wif || typeof wif !== 'string') {
            throw new SDKAuthError('INVALID_WIF', 'WIF private key is required for signing.');
        }

        const net = this._resolveNet(opts.network);
        let keyPair;

        try {
            keyPair = ECPair.fromWIF(wif, net);
        } catch (err) {
            throw new SDKAuthError('INVALID_WIF', `Failed to import WIF: ${err.message}`);
        }

        try {
            const privateKey = keyPair.privateKey;
            const compressed = keyPair.compressed;

            // bitcoinjs-message sign(message, privateKey, compressed, messagePrefix, sigOptions).
            // Signing is deterministic RFC 6979 by design: no extraEntropy is supplied
            // (elliptic GHSA-848j-6mx2-7j84 is an accepted advisory, see AUDIT-EXCEPTIONS.md).
            const sigOptions = {};
            if (opts.segwitRedeemScript) sigOptions.segwitType = 'p2sh(p2wpkh)';
            if (opts.segwitNative) sigOptions.segwitType = 'p2wpkh';

            const signature = bitcoinMessage.sign(
                message,
                privateKey,
                compressed,
                net.messagePrefix,
                Object.keys(sigOptions).length > 0 ? sigOptions : undefined
            );

            // Derive the address for the return value
            const bitcoin = require('bitcoinjs-lib');
            let address;
            if (opts.segwitNative) {
                address = bitcoin.payments.p2wpkh({ pubkey: keyPair.publicKey, network: net }).address;
            } else if (opts.segwitRedeemScript) {
                address = bitcoin.payments.p2sh({
                    redeem: bitcoin.payments.p2wpkh({ pubkey: keyPair.publicKey, network: net }),
                    network: net
                }).address;
            } else {
                address = bitcoin.payments.p2pkh({ pubkey: keyPair.publicKey, network: net }).address;
            }

            return {
                signature: signature.toString('base64'),
                address: address
            };
        } catch (err) {
            if (err.name === 'SDKAuthError') throw err;
            throw new SDKAuthError('SIGN_FAILED', `Message signing failed: ${err.message}`);
        }
    }

    /**
     * Verify wallet ownership: confirm a signature was produced by the private
     * key corresponding to the given address.
     *
     * Works with any message string.
     *
     * @param {string} address - Claimed owner address
     * @param {string} message - The original message that was signed
     * @param {string} signature - Base64 signature from signMessage
     * @param {string} [network] - Override instance network
     * @returns {{ valid: boolean, address: string, error: string|null }}
     */
    verifyOwnership(address, message, signature, network) {
        if (!address || typeof address !== 'string') {
            return { valid: false, address: address || null, error: 'Address is required.' };
        }
        if (!message || typeof message !== 'string') {
            return { valid: false, address: address, error: 'Message is required.' };
        }
        if (!signature || typeof signature !== 'string') {
            return { valid: false, address: address, error: 'Signature is required.' };
        }

        let net;
        try {
            net = this._resolveNet(network);
        } catch (err) {
            return { valid: false, address: address, error: err.message };
        }

        try {
            const valid = bitcoinMessage.verify(message, address, signature, net.messagePrefix);
            return { valid: !!valid, address: address, error: null };
        } catch (err) {
            return { valid: false, address: address, error: err.message };
        }
    }

    /**
     * Verify a signed message (generic form).
     *
     * @param {string} address
     * @param {string} message
     * @param {string} signature - Base64
     * @param {string} [network] - Override instance network
     * @returns {{ valid: boolean, error: string|null }}
     */
    verifyMessage(address, message, signature, network) {
        const result = this.verifyOwnership(address, message, signature, network);
        return { valid: result.valid, error: result.error };
    }
}

module.exports = AuthUtils;
