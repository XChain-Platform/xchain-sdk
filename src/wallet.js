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
// and extracted here (mirrors xchain-encoder/src/applyBufferutilsPatch.js).
require('./applyBufferutilsPatch');
const bitcoin = require('bitcoinjs-lib');
const psbtutils = require('bitcoinjs-lib/src/psbt/psbtutils');
const { ECPairFactory } = require('ecpair');
const ecc = require('@bitcoinerlab/secp256k1');
const { getNetwork, getSupportedNetworks, NETWORKS } = require('./networks.js');
const { SDKWalletError } = require('./errors.js');

const ECPair = ECPairFactory(ecc);

bitcoin.initEccLib(ecc);


/**
 * Serialize a bitcoinjs-lib Transaction into a plain-JSON shape
 * compatible with Trezor Connect's `refTxs` argument (and usable by
 * any other consumer that needs parsed prev-tx info without a dep on
 * bitcoinjs-lib). Used by decomposePsbt to pre-parse the prev-tx bytes
 * carried inside nonWitnessUtxo so the wallet's format converters
 * don't need to reach for bitcoinjs-lib themselves.
 *
 * Field names match Trezor's `RefTransaction` shape: `hash` is the
 * display-order txid, amounts are decimal-string sats, inputs expose
 * `prev_hash` / `prev_index` / `script_sig` / `sequence` and outputs
 * expose `amount` / `script_pubkey`. Extra fields that Trezor ignores
 * (but are handy for other converters) are omitted to keep the shape
 * predictable.
 *
 * @param {import('bitcoinjs-lib').Transaction} tx
 */
function serializePrevTx(tx) {
    return {
        hash: tx.getId(),
        version: tx.version,
        locktime: tx.locktime,
        inputs: tx.ins.map((inp) => ({
            prev_hash: Buffer.from(inp.hash).reverse().toString('hex'),
            prev_index: inp.index,
            script_sig: inp.script.toString('hex'),
            sequence: inp.sequence >>> 0,
        })),
        bin_outputs: tx.outs.map((out) => ({
            // String(bigint) is exact; the Number() hop rounds above 2^53.
            amount: String(out.value),
            script_pubkey: out.script.toString('hex'),
        })),
    };
}

/**
 * Classify a scriptPubKey (and optional redeemScript, for p2sh) into
 * one of the standard output types. Used by decomposePsbt to tag each
 * input/output so hardware-signer format converters know which envelope
 * to build. Inspects the raw opcode bytes rather than round-tripping
 * through bitcoinjs-lib's payment factories.
 *
 * @param {Buffer|null} scriptBuf         scriptPubKey bytes
 * @param {Buffer|null|undefined} redeemScriptBuf   redeemScript (p2sh only)
 * @returns {'p2wpkh'|'p2wsh'|'p2pkh'|'p2sh-p2wpkh'|'p2sh-p2wsh'|'p2sh'|'p2tr'|'unknown'}
 */
function classifyScript(scriptBuf, redeemScriptBuf) {
    if (!scriptBuf || scriptBuf.length === 0) return 'unknown';
    const b = scriptBuf;
    // P2WPKH: OP_0 <20-byte pubkey hash>
    if (b.length === 22 && b[0] === 0x00 && b[1] === 0x14) return 'p2wpkh';
    // P2WSH: OP_0 <32-byte script hash>
    if (b.length === 34 && b[0] === 0x00 && b[1] === 0x20) return 'p2wsh';
    // P2PKH: OP_DUP OP_HASH160 <20> OP_EQUALVERIFY OP_CHECKSIG
    if (b.length === 25 && b[0] === 0x76 && b[1] === 0xa9 && b[2] === 0x14
        && b[23] === 0x88 && b[24] === 0xac) {
        return 'p2pkh';
    }
    // P2SH: OP_HASH160 <20> OP_EQUAL; disambiguate via redeemScript.
    if (b.length === 23 && b[0] === 0xa9 && b[1] === 0x14 && b[22] === 0x87) {
        if (redeemScriptBuf && redeemScriptBuf.length > 0) {
            const r = redeemScriptBuf;
            if (r.length === 22 && r[0] === 0x00 && r[1] === 0x14) return 'p2sh-p2wpkh';
            if (r.length === 34 && r[0] === 0x00 && r[1] === 0x20) return 'p2sh-p2wsh';
        }
        return 'p2sh';
    }
    // P2TR: OP_1 <32-byte x-only pubkey>
    if (b.length === 34 && b[0] === 0x51 && b[1] === 0x20) return 'p2tr';
    return 'unknown';
}


class WalletUtils {

    constructor(network) {
        this.network = network || null;
        this._netParams = network ? getNetwork(network) : null;
    }

    _resolveNet(network) {
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

        if (scheme !== 'p2sh-multisig' && scheme !== 'p2wsh-multisig') {
            throw new SDKWalletError('INVALID_SCHEME',
                'scheme must be one of p2sh-multisig, p2wsh-multisig, taproot-musig2');
        }

        const parts = params.scriptTemplate.split(':');
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
    }

    /**
     * Produce a DER-encoded ECDSA signature over the given 32-byte
     * sighash using the given 32-byte secret key. Used by §22.3
     * P2SH / P2WSH classical multisig signing: each cosigner emits
     * one of these against the input's sighash; the coordinator's
     * PSBT finalizer assembles the threshold-of-N signatures into
     * the witness / redeem-script-input.
     *
     * No sighash flag byte is appended; callers that need one (PSBT
     * v0 inputs typically use SIGHASH_ALL = 0x01) append it
     * themselves so this method stays a thin ECDSA primitive.
     *
     * @param {Uint8Array} msgHash      32 bytes
     * @param {Uint8Array} secretKey    32 bytes
     * @returns {Uint8Array}            DER-encoded signature
     */
    signEcdsa(msgHash, secretKey) {
        if (!(msgHash instanceof Uint8Array) || msgHash.length !== 32) {
            throw new SDKWalletError('INVALID_INPUT', 'signEcdsa: msgHash must be a 32-byte Uint8Array');
        }
        if (!(secretKey instanceof Uint8Array) || secretKey.length !== 32) {
            throw new SDKWalletError('INVALID_INPUT', 'signEcdsa: secretKey must be a 32-byte Uint8Array');
        }
        if (!ecc.isPrivate(secretKey)) {
            throw new SDKWalletError('INVALID_INPUT', 'signEcdsa: secretKey is not a valid secp256k1 scalar');
        }
        const compactSig = ecc.sign(msgHash, secretKey);
        // ecc.sign returns the 64-byte compact (r || s) form. Convert
        // to DER for PSBT-finalizer compatibility; bitcoinjs-lib's
        // PSBT input slot expects DER-encoded signatures.
        return compactToDer(compactSig);
    }

    /**
     * Sign every input of a PSBT with a WIF, BUT do NOT finalize. Used
     * by xchain-wallet's classical (P2SH / P2WSH) multisig flow: each
     * cosigner's wallet calls this independently, then the coordinator
     * merges the resulting signed-but-unfinalized PSBTs together (the
     * signatures stack under each input's `partialSig` field) and runs
     * `finalizeMultisigPsbt` once threshold is met.
     *
     * For inputs that carry a `redeemScript` (P2SH) or `witnessScript`
     * (P2WSH), bitcoinjs-lib's `signAllInputs` correctly emits a partial
     * signature against the script's matching pubkey rather than trying
     * to assemble a single-sig witness.
     *
     * @param {string} psbtHex
     * @param {string} wif
     * @returns {{ psbtHex: string }}    PSBT with this WIF's partial sigs added
     */
    signMultisigPsbt(psbtHex, wif) {
        if (!psbtHex || typeof psbtHex !== 'string') {
            throw new SDKWalletError('INVALID_PSBT', 'signMultisigPsbt: PSBT hex is required');
        }
        if (!wif || typeof wif !== 'string') {
            throw new SDKWalletError('INVALID_WIF', 'signMultisigPsbt: WIF is required');
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
        try {
            psbt.signAllInputs(keyPair);
        } catch (err) {
            throw new SDKWalletError('SIGN_FAILED', `signMultisigPsbt: ${err.message}`);
        }
        return { psbtHex: psbt.toHex() };
    }

    /**
     * Finalize a PSBT that already has every input's signature
     * threshold met. Returns the broadcastable tx hex + txid.
     *
     * @param {string} psbtHex
     * @returns {{ txHex: string, txid: string, psbtHex: string }}
     */
    finalizeMultisigPsbt(psbtHex) {
        if (!psbtHex || typeof psbtHex !== 'string') {
            throw new SDKWalletError('INVALID_PSBT', 'finalizeMultisigPsbt: PSBT hex is required');
        }
        const net = this._resolveNet();
        let psbt;
        try {
            psbt = bitcoin.Psbt.fromHex(psbtHex, { network: net });
        } catch (err) {
            throw new SDKWalletError('INVALID_PSBT', `Failed to parse PSBT: ${err.message}`);
        }
        try {
            psbt.finalizeAllInputs();
        } catch (err) {
            throw new SDKWalletError('FINALIZE_FAILED', `finalizeMultisigPsbt: ${err.message}`);
        }
        const tx = psbt.extractTransaction();
        return {
            psbtHex: psbt.toHex(),
            txHex: tx.toHex(),
            txid: tx.getId(),
        };
    }

    /**
     * Resolve the fee ceiling (sat/vB) applied before extractTransaction.
     * bitcoinjs-lib's "absurd fee" guard defaults to 5000 sat/vB, calibrated
     * for BTC's unit value. On chains whose base unit is worth far less, an
     * ordinary fee blows past it (DOGE: a normal ~0.5 DOGE/kB estimator rate
     * is ~50k sat/vB), rejecting every transaction at signing. Non-bitcoin
     * networks therefore default to a far higher ceiling; real drain
     * protection belongs upstream in the encoder's MAX_FEE_RATE_KB cap.
     * Callers can override in either direction via opts.maximumFeeRate.
     *
     * @param {{ maximumFeeRate?: number }} [opts]
     * @returns {number|null} sat/vB ceiling, or null to keep bitcoinjs's default
     */
    _maxFeeRate(opts) {
        if (opts && Number.isFinite(opts.maximumFeeRate) && opts.maximumFeeRate > 0)
            return opts.maximumFeeRate;
        return String(this.network || '').startsWith('bitcoin') ? null : 10000000;
    }

    /**
     * Sign an unsigned PSBT hex string with a WIF private key.
     *
     * By default every input the key can sign is signed and finalized. When
     * `opts.inputIndices` is supplied, ONLY those inputs are signed/finalized;
     * this is how the wallet restricts a dApp-supplied PSBT to the exact inputs
     * the user was shown/approved, instead of blindly signing every UTXO the
     * active key controls. With a partial (scoped) sign the transaction is not
     * fully finalized, so the extracted tx is omitted and the partially-signed
     * PSBT is returned for the caller/counterparty to complete.
     *
     * @param {string} psbtHex - Unsigned PSBT from encoder, as hex
     * @param {string} wif - WIF-encoded private key
     * @param {{ maximumFeeRate?: number, inputIndices?: number[] }} [opts] - sat/vB
     *   fee ceiling override and/or the explicit set of input indices to sign
     * @returns {{ txHex: (string|null), txid: (string|null), psbtHex: string }}
     */
    signPsbt(psbtHex, wif, opts) {
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

        // Scoped signing: when an explicit input set is given, sign/finalize ONLY
        // those inputs. Any other input the key happens to control (e.g. a UTXO a
        // crafted PSBT mixed in that the user never approved) is left untouched.
        const scoped = (opts && Array.isArray(opts.inputIndices)) ? opts.inputIndices : null;
        if (scoped && scoped.length === 0) {
            throw new SDKWalletError('SIGN_FAILED', 'PSBT signing failed: inputIndices is empty');
        }

        try {
            if (scoped) {
                for (const i of scoped) psbt.signInput(i, keyPair);
            } else {
                psbt.signAllInputs(keyPair);
            }
        } catch (err) {
            throw new SDKWalletError('SIGN_FAILED', `PSBT signing failed: ${err.message}`);
        }

        try {
            if (scoped) {
                for (const i of scoped) psbt.finalizeInput(i);
            } else {
                psbt.finalizeAllInputs();
            }
        } catch (err) {
            throw new SDKWalletError('FINALIZE_FAILED', `PSBT finalization failed: ${err.message}`);
        }

        // Only extract a broadcastable tx when EVERY input is finalized. A scoped
        // partial sign deliberately leaves unapproved inputs unfinalized, so the tx
        // is incomplete; return the partially-signed PSBT rather than throwing or
        // emitting a half-finalized extraction.
        const allFinalized = psbt.data.inputs.every(
            (inp) => inp.finalScriptSig || inp.finalScriptWitness
        );
        if (!allFinalized) {
            return { txHex: null, txid: null, psbtHex: psbt.toHex() };
        }

        const maxFeeRate = this._maxFeeRate(opts);
        if (maxFeeRate) psbt.setMaximumFeeRate(maxFeeRate);
        const tx = psbt.extractTransaction();

        return {
            txHex: tx.toHex(),
            txid: tx.getId(),
            psbtHex: psbt.toHex()
        };
    }

    /**
     * Build a finalizer for XChain P2SH / P2WSH "reveal" inputs (the phase-2
     * transaction of the two-step large-action encoding. Each such input
     * spends a data-carrying P2SH/P2WSH output created by phase 1, so its
     * redeem/witness script is the non-standard XChain payload script and
     * bitcoinjs-lib's default finalizer cannot assemble it. We compile the
     * scriptSig / witness from the single partial signature + pubkey, wrapped
     * in the matching p2sh/p2wsh payment. Mirrors xchain-e2e-test's
     * transactionHelper.xchainP2shFinalizer, but network-aware.
     *
     * @param {object} net  bitcoinjs network params
     */
    _xchainRevealFinalizer(net) {
        return (inputIndex, input, script, isSegwit, isP2SH, isP2WSH) => {
            if (!input.partialSig || !input.partialSig[0]) {
                throw new SDKWalletError('FINALIZE_FAILED',
                    'reveal finalizer: input #' + inputIndex + ' has no partial signature');
            }
            const sig = bitcoin.script.compile([
                input.partialSig[0].signature,
                input.partialSig[0].pubkey,
            ]);
            if (isP2SH) {
                const payment = bitcoin.payments.p2sh({
                    network: net,
                    redeem: { network: net, input: sig, output: script },
                });
                return { finalScriptSig: payment.input, finalScriptWitness: undefined };
            }
            if (isP2WSH) {
                const payment = bitcoin.payments.p2wsh({
                    network: net,
                    redeem: { network: net, input: sig, output: script },
                });
                return {
                    finalScriptSig: undefined,
                    finalScriptWitness: psbtutils.witnessStackToScriptWitness(payment.witness),
                };
            }
            throw new SDKWalletError('FINALIZE_FAILED',
                'reveal finalizer: input #' + inputIndex + ' is neither P2SH nor P2WSH');
        };
    }

    /**
     * Sign the REVEAL half of a Taproot envelope pair (envelope spec §3.2/§3.5).
     *
     * Distinct from signRevealPsbt, which signs a P2SH/P2WSH chunk-lane reveal with
     * ECDSA and the xchain reveal finalizer. An envelope reveal is a BIP341
     * script-path spend: it needs a Schnorr signature over the tapleaf and the
     * standard taproot finalizer, so neither the key nor the finalizer from that
     * path applies here.
     *
     * Signs input 0 only, because §3.5 pins the commit outpoint at input 0 and
     * declares any additional reveal input the caller's own business; signing them
     * with this key would be wrong whenever they are not this key's.
     *
     * @param {string} psbtHex - the revealPsbt hex returned alongside the commit
     * @param {string} wif
     * @param {{ maximumFeeRate?: number }} [opts] - sat/vB fee ceiling override
     * @returns {{ txHex: string, txid: string, psbtHex: string }}
     */
    signEnvelopeRevealPsbt(psbtHex, wif, opts) {
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

        try {
            psbt.signInput(0, {
                publicKey: Buffer.from(keyPair.publicKey),
                signSchnorr: (hash) => Buffer.from(ecc.signSchnorr(hash, keyPair.privateKey)),
            });
        } catch (err) {
            throw new SDKWalletError('SIGN_FAILED', `Envelope reveal signing failed: ${err.message}`);
        }

        try {
            psbt.finalizeAllInputs();
        } catch (err) {
            throw new SDKWalletError('FINALIZE_FAILED', `Envelope reveal finalization failed: ${err.message}`);
        }

        const maxFeeRate = this._maxFeeRate(opts);
        if (maxFeeRate) psbt.setMaximumFeeRate(maxFeeRate);
        const tx = psbt.extractTransaction();
        return {
            txHex: tx.toHex(),
            txid: tx.getId(),
            psbtHex: psbt.toHex(),
        };
    }

    /**
     * Sign + finalize a P2SH/P2WSH reveal PSBT (phase 2 of large-action
     * encoding). Every input is a data-carrying reveal input, so each is
     * finalized with the custom XChain finalizer rather than the default.
     *
     * @param {string} psbtHex - phase-2 PSBT hex from encoder.spendP2sh
     * @param {string} wif
     * @param {{ maximumFeeRate?: number }} [opts] - sat/vB fee ceiling override
     * @returns {{ txHex: string, txid: string, psbtHex: string }}
     */
    signRevealPsbt(psbtHex, wif, opts) {
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

        try {
            psbt.signAllInputs(keyPair);
        } catch (err) {
            throw new SDKWalletError('SIGN_FAILED', `PSBT signing failed: ${err.message}`);
        }

        const finalizer = this._xchainRevealFinalizer(net);
        try {
            for (let i = 0; i < psbt.data.inputs.length; i += 1) {
                psbt.finalizeInput(i, finalizer);
            }
        } catch (err) {
            throw new SDKWalletError('FINALIZE_FAILED', `Reveal PSBT finalization failed: ${err.message}`);
        }

        const maxFeeRate = this._maxFeeRate(opts);
        if (maxFeeRate) psbt.setMaximumFeeRate(maxFeeRate);
        const tx = psbt.extractTransaction();
        return {
            txHex: tx.toHex(),
            txid: tx.getId(),
            psbtHex: psbt.toHex(),
        };
    }

    /**
     * Decompose an unsigned PSBT into a vendor-agnostic shape suitable
     * for driving external signers (Trezor Connect, Ledger hw-app-btc,
     * air-gapped displays). Returns prev-tx references, script types,
     * and amounts in a form a caller can translate into any vendor's
     * input/output envelope without touching bitcoinjs-lib.
     *
     * A satoshi value is a Number when exactly representable and an exact decimal
     * STRING above 2^53-1, matching applyBufferutilsPatch's own contract.
     *
     * The wallet tracks BIP32 derivation paths out-of-band (on its own
     * Address records), so the returned shape deliberately omits
     * derivation info; callers pair `inputs[i]` with the matching
     * signingPath by index.
     *
     * @param {string} psbtHex - Unsigned PSBT hex string from the encoder
     * @returns {{
     *   txVersion: number,
     *   locktime: number,
     *   network: string|null,
     *   inputs: Array<{
     *     prevTxHash: string,
     *     prevTxIndex: number,
     *     sequence: number,
     *     value: (number|string|null),
     *     scriptPubKeyHex: string,
     *     scriptType: string,
     *     sighashType: (number|null),
     *     nonWitnessUtxoHex: (string|null),
     *     witnessUtxoScriptHex: (string|null),
     *     redeemScriptHex: (string|null),
     *     witnessScriptHex: (string|null),
     *     address: (string|null),
     *     prevTxInfo: ({hash: string, version: number, locktime: number, inputs: Array<{prev_hash: string, prev_index: number, script_sig: string, sequence: number}>, bin_outputs: Array<{amount: string, script_pubkey: string}>}|null),
     *   }>,
     *   outputs: Array<{
     *     address: (string|null),
     *     scriptPubKeyHex: string,
     *     scriptType: string,
     *     value: (number|string),
     *   }>
     * }}
     */
    decomposePsbt(psbtHex) {
        if (!psbtHex || typeof psbtHex !== 'string') {
            throw new SDKWalletError('INVALID_PSBT', 'PSBT hex string is required.');
        }

        const net = this._resolveNet();

        let psbt;
        try {
            psbt = bitcoin.Psbt.fromHex(psbtHex, { network: net });
        } catch (err) {
            throw new SDKWalletError('INVALID_PSBT', `Failed to parse PSBT: ${err.message}`);
        }

        const inputs = [];
        for (let i = 0; i < psbt.data.inputs.length; i += 1) {
            const psbtInput = psbt.data.inputs[i];
            const txInput = psbt.txInputs[i];

            // txInput.hash is little-endian; reverse to get display-order txid hex.
            const prevTxHash = Buffer.from(txInput.hash).reverse().toString('hex');

            let value = null;
            let scriptPubKeyBuf = null;
            let nonWitnessUtxoHex = null;
            let witnessUtxoScriptHex = null;
            let prevTxInfo = null;

            if (psbtInput.witnessUtxo) {
                // Widen ONLY above 2^53, matching applyBufferutilsPatch's own contract:
                // a Number stays a Number, a BigInt becomes an exact decimal string
                // rather than a rounded double.
                value = typeof psbtInput.witnessUtxo.value === 'bigint'
                    ? String(psbtInput.witnessUtxo.value) : psbtInput.witnessUtxo.value;
                scriptPubKeyBuf = psbtInput.witnessUtxo.script;
                witnessUtxoScriptHex = scriptPubKeyBuf.toString('hex');
            } else if (psbtInput.nonWitnessUtxo) {
                nonWitnessUtxoHex = psbtInput.nonWitnessUtxo.toString('hex');
                try {
                    const prevTx = bitcoin.Transaction.fromBuffer(psbtInput.nonWitnessUtxo);
                    const out = prevTx.outs[txInput.index];
                    if (out) {
                        value = typeof out.value === 'bigint' ? String(out.value) : out.value;
                        scriptPubKeyBuf = out.script;
                    }
                    prevTxInfo = serializePrevTx(prevTx);
                } catch (err) {
                    throw new SDKWalletError('INVALID_PSBT',
                        `Input ${i}: failed to parse nonWitnessUtxo: ${err.message}`);
                }
            } else {
                throw new SDKWalletError('INVALID_PSBT',
                    `Input ${i}: PSBT missing both witnessUtxo and nonWitnessUtxo.`);
            }

            // Report the full previous transaction whenever the PSBT carries one,
            // even alongside a witnessUtxo. This used to be an
            // else-if, so a PSBT carrying BOTH silently lost its prev tx - and
            // a hardware signer cannot sign without it, because Ledger derives
            // the outpoint it signs from those bytes rather than from the
            // PSBT's own txid. Value and script still come from the witnessUtxo
            // when present, so nothing that already worked changes; this only
            // stops information the PSBT contains from being dropped.
            if (nonWitnessUtxoHex === null && psbtInput.nonWitnessUtxo) {
                nonWitnessUtxoHex = psbtInput.nonWitnessUtxo.toString('hex');
                try {
                    prevTxInfo = serializePrevTx(bitcoin.Transaction.fromBuffer(psbtInput.nonWitnessUtxo));
                } catch { /* the witnessUtxo already gave us value + script */ }
            }

            const scriptPubKeyHex = scriptPubKeyBuf
                ? scriptPubKeyBuf.toString('hex')
                : '';
            const redeemScriptHex = psbtInput.redeemScript
                ? psbtInput.redeemScript.toString('hex')
                : null;
            const witnessScriptHex = psbtInput.witnessScript
                ? psbtInput.witnessScript.toString('hex')
                : null;

            const scriptType = classifyScript(scriptPubKeyBuf, psbtInput.redeemScript);

            let address = null;
            if (scriptPubKeyBuf) {
                try {
                    address = bitcoin.address.fromOutputScript(scriptPubKeyBuf, net);
                } catch {
                    address = null;
                }
            }

            inputs.push({
                prevTxHash,
                prevTxIndex: txInput.index,
                sequence: txInput.sequence >>> 0,
                value,
                scriptPubKeyHex,
                scriptType,
                sighashType: typeof psbtInput.sighashType === 'number'
                    ? psbtInput.sighashType
                    : null,
                nonWitnessUtxoHex,
                witnessUtxoScriptHex,
                redeemScriptHex,
                witnessScriptHex,
                address,
                prevTxInfo,
            });
        }

        const outputs = [];
        for (let i = 0; i < psbt.txOutputs.length; i += 1) {
            const txOut = psbt.txOutputs[i];
            const scriptBuf = txOut.script;
            const scriptPubKeyHex = scriptBuf.toString('hex');
            const scriptType = classifyScript(scriptBuf, null);

            let address = null;
            try {
                address = bitcoin.address.fromOutputScript(scriptBuf, net);
            } catch {
                address = null;
            }

            outputs.push({
                address,
                scriptPubKeyHex,
                scriptType,
                value: typeof txOut.value === 'bigint' ? String(txOut.value) : txOut.value,
            });
        }

        return {
            txVersion: psbt.version,
            locktime: psbt.locktime,
            network: this.network ?? null,
            inputs,
            outputs,
        };
    }

    /**
     * Compute the txid (display-order hex) of a fully-serialized
     * transaction hex string. Used by the hardware-signer path, which
     * receives a signed `serializedTx` from the device and still needs
     * a txid for broadcast wiring. Handles both legacy and segwit
     * serializations; bitcoinjs-lib's `Transaction.fromHex` auto-
     * detects the segwit marker and `getId()` computes the txid over
     * the non-witness portion correctly.
     *
     * @param {string} txHex
     * @returns {string}
     */
    txidOf(txHex) {
        if (!txHex || typeof txHex !== 'string') {
            throw new SDKWalletError('INVALID_TX_HEX', 'Transaction hex string is required.');
        }
        try {
            return bitcoin.Transaction.fromHex(txHex).getId();
        } catch (err) {
            throw new SDKWalletError('INVALID_TX_HEX', `Failed to parse transaction: ${err.message}`);
        }
    }

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

/**
 * Convert a 64-byte (r||s) compact ECDSA signature to DER. Used by
 * `WalletUtils.signEcdsa` so callers get the form bitcoinjs-lib's
 * PSBT-input slot expects.
 *
 * @param {Uint8Array} compact   64 bytes
 * @returns {Uint8Array}
 */
function compactToDer(compact) {
    const r = trimLeading(compact.subarray(0, 32));
    const s = trimLeading(compact.subarray(32, 64));
    const inner = new Uint8Array(2 + r.length + 2 + s.length);
    let off = 0;
    inner[off++] = 0x02;
    inner[off++] = r.length;
    inner.set(r, off); off += r.length;
    inner[off++] = 0x02;
    inner[off++] = s.length;
    inner.set(s, off);
    const out = new Uint8Array(2 + inner.length);
    out[0] = 0x30;
    out[1] = inner.length;
    out.set(inner, 2);
    return out;
}

function trimLeading(bytes) {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0x00 && (bytes[i + 1] & 0x80) === 0) i++;
    const trimmed = bytes.subarray(i);
    // BIP-66 requires the high bit of the first byte to be 0; if it
    // would be 1, prepend a 0x00 so the integer stays positive in DER.
    if (trimmed[0] & 0x80) {
        const padded = new Uint8Array(trimmed.length + 1);
        padded[0] = 0x00;
        padded.set(trimmed, 1);
        return padded;
    }
    return trimmed;
}

module.exports = WalletUtils;
