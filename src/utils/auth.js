// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const crypto = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const signedMessage = require('./signed_message.js');
const { createECPair } = require('./bitcoinjs_compat/ecpair.js');
const ecc = require('@bitcoinerlab/secp256k1');
const { getNetwork } = require('../protocol/networks.js');
const { SDKAuthError } = require('./errors.js');
const { parseLoginChallenge, checkLoginChallenge } = require('./wallet/login_challenge.js');

const ECPair = createECPair(ecc);
const BIP322_PREFIX = 'smp';
const BIP322_TAG = 'BIP0322-signed-message';
bitcoin.initEccLib(ecc);
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

function asBuffer(value) {
    return Buffer.isBuffer(value) ? value : Buffer.from(value);
}
function bip322MessageHash(message) {
    const tagHash = crypto.createHash('sha256').update(BIP322_TAG, 'utf8').digest();
    return crypto.createHash('sha256').update(tagHash).update(tagHash).update(message, 'utf8').digest();
}

function p2trScript(address, network) {
    const script = asBuffer(bitcoin.address.toOutputScript(address, network));
    if (script.length !== 34 || script[0] !== bitcoin.opcodes.OP_1 || script[1] !== 0x20) {
        throw new TypeError('BIP-322 simple signing requires a P2TR address.');
    }
    return script;
}

function bip322Transactions(message, address, network) {
    const challenge = p2trScript(address, network);
    const toSpend = new bitcoin.Transaction();
    toSpend.version = 0;
    toSpend.locktime = 0;
    toSpend.addInput(Buffer.alloc(32), 0xffffffff, 0,
        bitcoin.script.compile([bitcoin.opcodes.OP_0, bip322MessageHash(message)]));
    toSpend.addOutput(challenge, 0n);
    const toSign = new bitcoin.Transaction();
    toSign.version = 0;
    toSign.locktime = 0;
    toSign.addInput(asBuffer(toSpend.getHash()), 0, 0, Buffer.alloc(0));
    toSign.addOutput(Buffer.from([bitcoin.opcodes.OP_RETURN]), 0n);
    return { challenge, toSign };
}

function taprootKey(privateKey, publicKey) {
    const fullPublicKey = asBuffer(publicKey);
    const internalKey = fullPublicKey.subarray(1, 33);
    const tweak = asBuffer(bitcoin.crypto.taggedHash('TapTweak', internalKey));
    const hasOddY = fullPublicKey[0] === 0x03 ||
        (fullPublicKey[0] === 0x04 && (fullPublicKey[64] & 1) === 1);
    const evenPrivateKey = hasOddY ? asBuffer(ecc.privateNegate(privateKey)) : asBuffer(privateKey);
    const tweakedPrivateKey = ecc.privateAdd(evenPrivateKey, tweak);
    if (!tweakedPrivateKey) throw new Error('Invalid Taproot key tweak.');
    return { internalKey, privateKey: asBuffer(tweakedPrivateKey) };
}

function decodeBip322Signature(value) {
    if (typeof value !== 'string' || value.length === 0) throw new TypeError('Signature is required.');
    let encoded = value;
    if (encoded.startsWith(BIP322_PREFIX)) encoded = encoded.slice(BIP322_PREFIX.length);
    else if (/^(?:ful|pof)/.test(encoded)) throw new TypeError('Signature is not BIP-322 simple format.');
    if (encoded.length === 0 || encoded.length % 4 !== 0 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
        throw new TypeError('Signature is not valid base64.');
    }
    const witness = Buffer.from(encoded, 'base64');
    const length = witness[1];
    if (witness[0] !== 1 || (length !== 64 && length !== 65) || witness.length !== length + 2) {
        throw new TypeError('Invalid BIP-322 simple witness.');
    }
    return witness.subarray(2);
}

function bip322Sign(message, keyPair, net, opts) {
    if (opts.segwitNative || opts.segwitRedeemScript) {
        throw new SDKAuthError('INVALID_SIGNATURE_FORMAT',
            'BIP-322 simple format cannot be combined with legacy SegWit options.');
    }
    const key = taprootKey(keyPair.privateKey, keyPair.publicKey);
    const payment = bitcoin.payments.p2tr({ internalPubkey: key.internalKey, network: net });
    const { challenge, toSign } = bip322Transactions(message, payment.address, net);
    const hash = asBuffer(toSign.hashForWitnessV1(0, [challenge], [0n], bitcoin.Transaction.SIGHASH_DEFAULT));
    let auxRand;
    if (opts.auxRand !== undefined) {
        auxRand = asBuffer(opts.auxRand);
        if (auxRand.length !== 32) throw new TypeError('BIP-322 auxiliary randomness must be 32 bytes.');
    }
    const signature = asBuffer(ecc.signSchnorr(hash, key.privateKey, auxRand));
    const witness = Buffer.concat([Buffer.from([1, signature.length]), signature]);
    return { address: payment.address, signature: BIP322_PREFIX + witness.toString('base64') };
}

function bip322Verify(address, message, signature, net) {
    try {
        const encodedSignature = decodeBip322Signature(signature);
        const hashType = encodedSignature.length === 64
            ? bitcoin.Transaction.SIGHASH_DEFAULT
            : encodedSignature[64];
        if (hashType !== bitcoin.Transaction.SIGHASH_DEFAULT &&
            hashType !== bitcoin.Transaction.SIGHASH_ALL) return false;
        if (encodedSignature.length === 65 && hashType === bitcoin.Transaction.SIGHASH_DEFAULT) return false;
        const { challenge, toSign } = bip322Transactions(message, address, net);
        const hash = asBuffer(toSign.hashForWitnessV1(0, [challenge], [0n], hashType));
        return ecc.verifySchnorr(hash, challenge.subarray(2), encodedSignature.subarray(0, 64));
    } catch (err) {
        return false;
    }
}

function loginFailure(error) {
    return { valid: false, address: null, chainId: null, addresses: [], error };
}
function challengePartsMatch(actual, expected) {
    if (!actual || typeof actual !== 'object') return false;
    return ['version', 'appId', 'origin', 'address', 'nonce', 'timestamp', 'expiresAt'].every(
        (field) => actual[field] === expected[field]);
}
function loginEntryError(auth, entry, expected, index) {
    if (!entry || typeof entry !== 'object') return `Login address ${index} is invalid.`;
    for (const field of ['address', 'chainId', 'challenge', 'signature', 'signatureFormat']) {
        if (typeof entry[field] !== 'string' || entry[field].length === 0) {
            return `Login address ${index} is missing ${field}.`;
        }
    }
    if (entry.signatureFormat !== 'legacy' && entry.signatureFormat !== 'bip322-simple') {
        return `Login address ${index} has an unsupported signatureFormat.`;
    }
    const parsed = parseLoginChallenge(entry.challenge);
    if (!parsed.ok) return parsed.error;
    const challengeError = checkLoginChallenge(parsed.parts, {
        appId: expected.appId,
        origin: expected.origin,
        nonce: expected.nonce,
        address: entry.address,
    }, expected);
    if (challengeError) return challengeError;
    if (entry.challengeParts !== undefined && !challengePartsMatch(entry.challengeParts, parsed.parts)) {
        return `Login address ${index} challengeParts mismatch.`;
    }
    const verified = auth.verifyOwnership(entry.address, entry.challenge, entry.signature,
        entry.chainId, { format: entry.signatureFormat });
    if (!verified.valid) return verified.error || `Login address ${index} signature is invalid.`;
    return null;
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

    // Generate a default or custom nonce-bound challenge for a site to store and later verify.
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

    // Sign any message with a WIF key in legacy or BIP-322 simple format.
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

    // Verify wallet ownership using the requested network and signature format.
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
                const valid = bip322Verify(address, message, signature, net);
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

    verifyMessage(address, message, signature, network, opts) {
        const result = this.verifyOwnership(address, message, signature, network, opts);
        return { valid: result.valid, error: result.error };
    }

    // Verify every signed address and the server-issued challenge bindings in a login result.
    verifyLogin(result, expected) {
        try {
            if (!result || typeof result !== 'object' || result.ok !== true) {
                return loginFailure('A successful login result is required.');
            }
            if (!expected || typeof expected !== 'object') {
                return loginFailure('Expected login fields are required.');
            }
            for (const field of ['appId', 'origin', 'nonce']) {
                if (typeof expected[field] !== 'string' || expected[field].length === 0) {
                    return loginFailure(`Expected login ${field} is required.`);
                }
            }
            if (!Array.isArray(result.addresses) || result.addresses.length === 0 || result.addresses.length > 5) {
                return loginFailure('Login result must contain between one and five addresses.');
            }
            const first = result.addresses[0];
            for (const field of ['address', 'chainId', 'challenge', 'signature', 'signatureFormat']) {
                if (!first || result[field] !== first[field]) {
                    return loginFailure(`Login top-level ${field} does not match the first address.`);
                }
            }

            const verifiedAddresses = [];
            for (let index = 0; index < result.addresses.length; index += 1) {
                const entry = result.addresses[index];
                const error = loginEntryError(this, entry, expected, index);
                if (error) return loginFailure(error);
                verifiedAddresses.push({ address: entry.address, chainId: entry.chainId });
            }

            const firstParsed = parseLoginChallenge(first.challenge);
            if (!challengePartsMatch(result.challengeParts, firstParsed.parts)) {
                return loginFailure('Login top-level challengeParts do not match the first address.');
            }
            return {
                valid: true,
                address: first.address,
                chainId: first.chainId,
                addresses: verifiedAddresses,
                error: null,
            };
        } catch (error) {
            return loginFailure('Invalid login result.');
        }
    }
}

module.exports = AuthUtils;
