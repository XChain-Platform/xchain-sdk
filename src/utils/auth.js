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
const bitcoin = require('bitcoinjs-lib');
const signedMessage = require('./signed_message.js');
const bip322 = require('./bip322.js');
const { createECPair } = require('./bitcoinjs_compat/ecpair.js');
const ecc = require('@bitcoinerlab/secp256k1');
const { getNetwork } = require('../protocol/networks.js');
const { SDKAuthError } = require('./errors.js');

const ECPair = createECPair(ecc);

// Refuse segwit signing modes where a witness program is anyone-can-spend, as key_derivation.js does
function refuseSegwitWithoutSupport(net, opts, networkName) {
    if ((opts.segwitNative || opts.segwitRedeemScript || opts.format === 'bip322-simple') &&
        net.supportsSegwit === false) {
        throw new SDKAuthError('SEGWIT_NOT_SUPPORTED',
            `SegWit message signing is not supported on ${networkName}.`);
    }
}

// Fill the supported placeholders in a custom challenge. A replacer function keeps
// a "$" in the message or values literal. signMessage refuses a non-string message
// with the same code, so refusing it here only moves the error earlier.
function fillCustomChallenge(message, fields) {
    if (typeof message !== 'string') {
        throw new SDKAuthError('INVALID_MESSAGE', 'Custom challenge message must be a string.');
    }
    return message.replace(/\{(nonce|address|timestamp|expiresAt)\}/g, (match, key) => String(fields[key]));
}

function hasDelimitedToken(text, token) {
    let from = 0;
    while (from < text.length) {
        const index = text.indexOf(token, from);
        if (index === -1) return false;
        const before = index === 0 || !/[A-Za-z0-9]/.test(text[index - 1]);
        const end = index + token.length;
        const after = end === text.length || !/[A-Za-z0-9]/.test(text[end]);
        if (before && after) return true;
        from = index + 1;
    }
    return false;
}

function bip322Sign(message, keyPair, net, opts) {
    if (opts.segwitNative || opts.segwitRedeemScript) {
        throw new SDKAuthError('INVALID_SIGNATURE_FORMAT',
            'BIP-322 simple format cannot be combined with legacy SegWit options.');
    }
    return bip322.signSimple(message, keyPair.privateKey, keyPair.publicKey, net, {
        auxRand: opts.auxRand
    });
}

function legacyAddress(keyPair, net, opts) {
    if (opts.segwitNative) {
        return bitcoin.payments.p2wpkh({ pubkey: keyPair.publicKey, network: net }).address;
    }
    if (opts.segwitRedeemScript) {
        return bitcoin.payments.p2sh({
            redeem: bitcoin.payments.p2wpkh({ pubkey: keyPair.publicKey, network: net }),
            network: net
        }).address;
    }
    return bitcoin.payments.p2pkh({ pubkey: keyPair.publicKey, network: net }).address;
}

function legacySign(message, keyPair, net, opts) {
    const sigOptions = {};
    if (opts.segwitRedeemScript) sigOptions.segwitType = 'p2sh(p2wpkh)';
    if (opts.segwitNative) sigOptions.segwitType = 'p2wpkh';
    const signature = signedMessage.sign(
        message,
        keyPair.privateKey,
        keyPair.compressed,
        net.messagePrefix,
        Object.keys(sigOptions).length > 0 ? sigOptions : undefined
    );
    return {
        signature: signature.toString('base64'),
        address: legacyAddress(keyPair, net, opts)
    };
}


class AuthUtils {

    constructor(network) {
        this.network = network || null;
        this._netParams = network ? getNetwork(network) : null;
    }

    // Resolve network params: instance default or per-call override
    resolveNet(network) {
        if (network) return getNetwork(network);
        if (this._netParams) return this._netParams;
        throw new SDKAuthError('NETWORK_NOT_CONFIGURED',
            'Network not configured. Provide network in SDK options or pass it to this method.');
    }

    /**
     * Generate a challenge for the user to sign.
     *
     * If opts.message is provided, its {nonce}, {address}, {timestamp} and
     * {expiresAt} placeholders are filled and the rest is used as-is.
     * Otherwise a default structured message is generated including the
     * address and nonce.
     *
     * Stateless: the caller stores the nonce and enforces expiry/single-use.
     * That only guards against replay when `bound` is true. For custom
     * messages, that requires the SDK to fill {nonce}, or an SDK-generated
     * nonce to appear as a whole delimited token. Literal matches for a
     * caller-supplied nonce do not count as binding.
     *
     * @param {string} address - The address being verified
     * @param {Object} [opts]
     * @param {string} [opts.appId='XChain'] - Application identifier
     * @param {string} [opts.nonce] - Override auto-generated nonce; custom messages bind it only via {nonce}
     * @param {string} [opts.message] - Custom message; may use {nonce}, {address}, {timestamp}, {expiresAt}
     * @param {boolean} [opts.requireNonce=false] - Refuse a custom message whose nonce is not bound
     * @param {number} [opts.expiresInMs=300000] - Expiry window in ms (default 5 min)
     * @returns {{ challenge: string, nonce: string, timestamp: string, expiresAt: string, bound: boolean }}
     * @throws {SDKAuthError} INVALID_MESSAGE when a custom message is not a string (signMessage refuses it too)
     * @throws {SDKAuthError} CHALLENGE_UNBOUND when opts.requireNonce is set and the nonce is not bound
     */
    generateChallenge(address, opts = {}) {
        if (!address || typeof address !== 'string') {
            throw new SDKAuthError('INVALID_ADDRESS', 'Address is required for challenge generation.');
        }

        const nonceWasSupplied = Boolean(opts.nonce);
        const nonce = opts.nonce || crypto.randomBytes(32).toString('hex');
        const timestamp = new Date().toISOString();
        const expiresInMs = opts.expiresInMs || 300000;
        const expiresAt = new Date(Date.now() + expiresInMs).toISOString();

        if (opts.message) {
            const noncePlaceholder = typeof opts.message === 'string' && opts.message.includes('{nonce}');
            const challenge = fillCustomChallenge(opts.message, { nonce, address, timestamp, expiresAt });
            const generatedToken = !nonceWasSupplied && hasDelimitedToken(challenge, String(nonce));
            const bound = noncePlaceholder || generatedToken;
            if (!bound) this.refuseOrWarnUnbound(opts);
            return { challenge, nonce, timestamp, expiresAt, bound };
        }

        // Default structured message
        const appId = opts.appId || 'XChain';
        const challenge = `XChain wallet verification\nApp: ${appId}\nAddress: ${address}\nNonce: ${nonce}\nTimestamp: ${timestamp}`;
        return { challenge, nonce, timestamp, expiresAt, bound: true };
    }

    // A custom challenge without a bound nonce gives no replay protection: refuse it
    // under requireNonce, otherwise warn once per instance and let it through.
    refuseOrWarnUnbound(opts) {
        if (opts.requireNonce) {
            throw new SDKAuthError('CHALLENGE_UNBOUND',
                'Custom challenge message must bind the nonce. Include {nonce}.');
        }
        if (this._unboundWarned) return;
        this._unboundWarned = true;
        if (typeof process === 'object' && process && typeof process.emitWarning === 'function') {
            process.emitWarning('generateChallenge: the custom message does not bind the returned nonce, ' +
                'so its signature can be replayed. Include {nonce} or pass requireNonce: true.',
                'UnboundChallengeWarning');
        }
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
     * @param {'legacy'|'bip322-simple'} [opts.format='legacy'] - Signature format
     * @param {Uint8Array} [opts.auxRand] - Optional 32-byte BIP-340 auxiliary randomness
     * @returns {{ signature: string, address: string }}
     * @throws {SDKAuthError} SEGWIT_NOT_SUPPORTED when a segwit option is set on a non-segwit network (dogecoin-*)
     */
    signMessage(message, wif, opts = {}) {
        if (!message || typeof message !== 'string') {
            throw new SDKAuthError('INVALID_MESSAGE', 'Message is required for signing.');
        }
        if (!wif || typeof wif !== 'string') {
            throw new SDKAuthError('INVALID_WIF', 'WIF private key is required for signing.');
        }

        const net = this.resolveNet(opts.network);
        refuseSegwitWithoutSupport(net, opts, opts.network || this.network);
        let keyPair;

        try {
            keyPair = ECPair.fromWIF(wif, net);
        } catch (err) {
            throw new SDKAuthError('INVALID_WIF', `Failed to import WIF: ${err.message}`);
        }

        try {
            const format = opts.format || 'legacy';
            if (format === 'bip322-simple') {
                return bip322Sign(message, keyPair, net, opts);
            }
            if (format !== 'legacy') {
                throw new SDKAuthError('INVALID_SIGNATURE_FORMAT',
                    `Unsupported message signature format: ${format}.`);
            }
            return legacySign(message, keyPair, net, opts);
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
     * @param {string|Object} [network] - Override instance network, or verification options
     * @param {Object} [opts]
     * @param {'legacy'|'bip322-simple'} [opts.format='legacy'] - Signature format
     * @returns {{ valid: boolean, address: string, error: string|null }}
     */
    verifyOwnership(address, message, signature, network, opts = {}) {
        if (!address || typeof address !== 'string') {
            return { valid: false, address: address || null, error: 'Address is required.' };
        }
        if (!message || typeof message !== 'string') {
            return { valid: false, address: address, error: 'Message is required.' };
        }
        if (!signature || typeof signature !== 'string') {
            return { valid: false, address: address, error: 'Signature is required.' };
        }

        if (network && typeof network === 'object') {
            opts = network;
            network = opts.network;
        }

        let net;
        try {
            net = this.resolveNet(network);
        } catch (err) {
            return { valid: false, address: address, error: err.message };
        }

        try {
            const format = opts.format || 'legacy';
            if (format === 'bip322-simple') {
                const valid = bip322.verifySimple(address, message, signature, net);
                return {
                    valid,
                    address: address,
                    error: valid ? null : 'Invalid BIP-322 simple signature.'
                };
            }
            if (format !== 'legacy') {
                return { valid: false, address: address, error: `Unsupported message signature format: ${format}.` };
            }
            const valid = signedMessage.verify(message, address, signature, net.messagePrefix);
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
     * @param {string|Object} [network] - Override instance network, or verification options
     * @param {Object} [opts] - Verification options
     * @returns {{ valid: boolean, error: string|null }}
     */
    verifyMessage(address, message, signature, network, opts) {
        const result = this.verifyOwnership(address, message, signature, network, opts);
        return { valid: result.valid, error: result.error };
    }
}

module.exports = AuthUtils;
