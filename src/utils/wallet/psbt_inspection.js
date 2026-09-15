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
const { SDKWalletError } = require('../errors.js');

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

module.exports = {
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
            // even alongside a witnessUtxo. Keeping this independent from the
            // witness branch prevents a PSBT carrying BOTH from losing its prev tx,
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
    },

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
    },

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
    },

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
    },
};

Object.defineProperties(module.exports, {
    serializePrevTx: { value: serializePrevTx },
    classifyScript: { value: classifyScript },
});
