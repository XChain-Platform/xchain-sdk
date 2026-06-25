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
 * XChain Platform SDK - Encoder Client
 *
 * JSON-RPC client wrapping the xchain-encoder create_tx method
 *
 ********************************************************************/

const axios = require('axios');
const { SDKEncoderError } = require('./errors.js');
const { withRetry, isRetryable } = require('./retry.js');


class EncoderClient {

    constructor(options = {}) {
        this.baseUrl = options.encoderUrl || 'localhost';
        this.port    = options.encoderPort || 3000;
        this.timeout = options.timeout || 30000;
        this._pool   = options.pool || {};

        // Lazy-readiness hook (awaited once before the first request so the SDK
        // can overlay hub-discovered endpoints). No-op when not supplied.
        this._readyHook = options.readyHook || null;

        // Build the pooled axios client for the current baseUrl/port.
        this._buildClient();

        this._rpcId = 0;

        // Retry configuration
        this.retry = options.retry !== undefined ? options.retry : {};
        // Hooks
        this.hooks = options.hooks || {};
    }

    // (Re)build the axios client + keep-alive agent for the current target.
    // Picks an https agent for https bases (axios ignores httpAgent on https),
    // so connection pooling applies to public hosts too.
    _buildClient() {
        let pool    = this._pool;
        let baseURL = this.baseUrl.startsWith('http') ? this.baseUrl : 'http://' + this.baseUrl + ':' + this.port;
        let isHttps = baseURL.startsWith('https');
        let Agent   = isHttps ? require('https').Agent : require('http').Agent;
        this._agent = new Agent({
            keepAlive:      pool.keepAlive !== undefined ? pool.keepAlive : true,
            keepAliveMsecs: pool.keepAliveMsecs || 1000,
            maxSockets:     pool.maxSockets || 10,
            maxFreeSockets: pool.maxFreeSockets || 5
        });
        this.client = axios.create({
            baseURL: baseURL,
            timeout: this.timeout,
            headers: { 'Content-Type': 'application/json' },
            httpAgent:  isHttps ? undefined : this._agent,
            httpsAgent: isHttps ? this._agent : undefined
        });
    }

    // Repoint this client at a new host/port (used by hub-discovery overlay).
    // No-ops if nothing changed so in-flight callers keep a stable client.
    setBase(url, port) {
        if (!url && !port) return;
        let newUrl  = url  || this.baseUrl;
        let newPort = port || this.port;
        if (newUrl === this.baseUrl && newPort === this.port) return;
        this.baseUrl = newUrl;
        this.port    = newPort;
        this._buildClient();
    }

    async _rpc(method, params = {}) {
        if (this._readyHook) await this._readyHook();
        let self = this;
        let retryConfig = this.retry === false ? { maxRetries: 0 } : this.retry;

        let onRetry = this.hooks.onRetry ? (attempt, delay, err) => {
            this.hooks.onRetry({ service: 'encoder', method, attempt, delay, error: err.message });
        } : null;

        try {
            return await withRetry(async () => {
                let payload = {
                    jsonrpc: '2.0',
                    method:  method,
                    params:  params,
                    id:      ++self._rpcId
                };

                if (self.hooks.onRequest)
                    self.hooks.onRequest({ service: 'encoder', method, params });

                try {
                    let response = await self.client.post('/', payload);
                    let body = response.data;

                    if (body && body.error) {
                        let err = new SDKEncoderError(
                            'ENCODER_RPC_ERROR',
                            'Encoder RPC error: ' + (body.error.message || JSON.stringify(body.error)),
                            { method, rpcError: body.error, context: body.error.data || null }
                        );
                        if (self.hooks.onError)
                            self.hooks.onError({ service: 'encoder', method, error: err.message });
                        throw err;
                    }

                    if (self.hooks.onResponse)
                        self.hooks.onResponse({ service: 'encoder', method, result: body ? body.result : null });

                    return body ? body.result : undefined;
                } catch (err) {
                    if (err instanceof SDKEncoderError) throw err;
                    if (self.hooks.onError)
                        self.hooks.onError({ service: 'encoder', method, error: err.message });
                    // Re-throw raw error so withRetry can inspect retryability; wrap only when not retryable
                    if (isRetryable(err)) throw err;
                    self._handleError(err, method);
                }
            }, retryConfig, onRetry);
        } catch (err) {
            // After all retries, wrap any raw (non-SDK) error into a typed SDKEncoderError
            if (err instanceof SDKEncoderError) throw err;
            self._handleError(err, method);
        }
    }

    _handleError(err, method) {
        if (err.response) {
            throw new SDKEncoderError(
                'ENCODER_HTTP_' + err.response.status,
                'Encoder returned HTTP ' + err.response.status + ' for method ' + method,
                { method, status: err.response.status, data: err.response.data }
            );
        }
        if (err.code === 'ECONNABORTED') {
            throw new SDKEncoderError('ENCODER_TIMEOUT', 'Encoder request timed out', { method, timeout: this.timeout });
        }
        throw new SDKEncoderError('ENCODER_NETWORK', 'Encoder request failed: ' + err.message, { method, error: err.message });
    }

    async ping() {
        return this._rpc('ping');
    }

    // Reports whether the encoder's hard dependencies are healthy. The
    // tracker_reachable / tracker_synced / tracker_lag fields tell the caller
    // whether the encoder can actually build transactions; a green ping() does
    // not guarantee a reachable UTXO tracker. Maps to the encoder's `health` RPC.
    async health() {
        return this._rpc('health');
    }

    // Returns suggested fee tiers (base-unit per vByte: sat/litoshi/koinu) from
    // the coin node's estimatesmartfee at three confirmation targets: low (6
    // blocks), medium (3 blocks), high (1 block). Use the chosen tier's value as
    // feePerKb (multiply by 1000) when calling createTx. Maps to encoder `estimate_fee`.
    // Note: this is distinct from estimateFee(), which builds a tx and parses the PSBT
    // to compute the actual fee amount of that specific transaction.
    async getFeeTiers() {
        return this._rpc('estimate_fee');
    }

    // Accepts the full parameter set supported by xchain-encoder's create_tx
    //
    // Required:
    //   data    - ACTION string to embed (from createAction)
    //   pubkey  - sender's public key or address
    //
    // Optional:
    //   change           - change address (defaults to pubkey on encoder side)
    //   utxos            - array of UTXO objects; null = auto-fetch from UTXO tracker
    //   rawData          - additional raw data to append (used by FILE action)
    //   encoding         - force encoding: OP_RETURN, P2SH, P2WSH, MULTISIGN
    //   fee              - fixed fee in satoshis
    //   feePerKb         - fee rate in sat/KB for auto-calculation
    //   rbf              - enable Replace-by-Fee
    //   dust             - dust threshold override
    //   unconfirmed      - include unconfirmed UTXOs (default true)
    //   compressedPubKey - required for MULTISIGN encoding
    //   customOutputs    - additional transaction outputs
    //   feeQuote         - protocol fee { address, amount } from hub
    //
    // Returns: { psbt: <hex>, encoding: <string> }
    async createTx(params) {
        if (!params.data)
            throw new SDKEncoderError('MISSING_DATA', 'createTx requires data (ACTION string)');
        if (!params.pubkey)
            throw new SDKEncoderError('MISSING_PUBKEY', 'createTx requires pubkey');

        let rpcParams = {
            data:   params.data,
            pubkey: params.pubkey
        };

        // Map optional fields
        if (params.change !== undefined)           rpcParams.change = params.change;
        if (params.utxos !== undefined)            rpcParams.utxos = params.utxos;
        if (params.rawData !== undefined)          rpcParams.rawData = params.rawData;
        if (params.encoding !== undefined)         rpcParams.encoding = String(params.encoding).toUpperCase();
        if (params.fee !== undefined)              rpcParams.fee = params.fee;
        if (params.feePerKb !== undefined)         rpcParams.feePerKb = params.feePerKb;
        if (params.rbf !== undefined)              rpcParams.rbf = params.rbf;
        if (params.dust !== undefined)             rpcParams.dust = params.dust;
        if (params.unconfirmed !== undefined)      rpcParams.unconfirmed = params.unconfirmed;
        if (params.compressedPubKey !== undefined) rpcParams.compressedPubKey = params.compressedPubKey;
        if (params.customOutputs !== undefined)    rpcParams.customOutputs = params.customOutputs;
        if (params.feeQuote !== undefined)         rpcParams.feeQuote = params.feeQuote;

        return this._rpc('create_tx', rpcParams);
    }

    // P2SH/P2WSH two-phase helper: spend a previously created P2SH/P2WSH output
    // This is phase 2 of the two-transaction pattern used by P2SH/P2WSH encoding
    //
    // Required:
    //   pubkey   - sender's public key or address
    //   p2shHash - hash of the P2SH output to spend
    //   p2shHex  - full transaction hex containing the P2SH output
    //
    // Optional:
    //   change, fee, feePerKb, rbf, dust, unconfirmed, compressedPubKey, encoding, rawData
    //   customOutputs - additional outputs to emit on the reveal (phase 2). On
    //     native-fee chains the protocol fee output MUST ride the reveal tx,
    //     because the indexer treats the reveal (not the funding tx) as the
    //     action and reads the fee output from it. The funding tx (phase 1) is
    //     sized by the encoder to fund these reveal outputs without emitting
    //     them, so the value is not double-paid.
    //
    // Returns: { psbt: <hex>, encoding: <string> }
    async spendP2sh(params) {
        if (!params.pubkey)
            throw new SDKEncoderError('MISSING_PUBKEY', 'spendP2sh requires pubkey');
        if (!params.p2shHash)
            throw new SDKEncoderError('MISSING_P2SH_HASH', 'spendP2sh requires p2shHash');
        if (!params.p2shHex)
            throw new SDKEncoderError('MISSING_P2SH_HEX', 'spendP2sh requires p2shHex');

        // Phase 2 must be built with the SAME action data + encoding as phase 1;
        // the encoder re-derives the reveal script chunks from them. Sending empty
        // data makes the encoder fail to build the reveal outputs.
        let rpcParams = {
            pubkey:  params.pubkey,
            p2shHash: params.p2shHash,
            p2shHex:  params.p2shHex,
            data:     params.data !== undefined && params.data !== null ? params.data : ''
        };

        if (params.encoding !== undefined)         rpcParams.encoding = String(params.encoding).toUpperCase();
        if (params.rawData !== undefined)          rpcParams.rawData = params.rawData;
        if (params.compressedPubKey !== undefined) rpcParams.compressedPubKey = params.compressedPubKey;
        if (params.change !== undefined)           rpcParams.change = params.change;
        if (params.fee !== undefined)              rpcParams.fee = params.fee;
        if (params.feePerKb !== undefined)         rpcParams.feePerKb = params.feePerKb;
        if (params.rbf !== undefined)              rpcParams.rbf = params.rbf;
        if (params.dust !== undefined)             rpcParams.dust = params.dust;
        if (params.unconfirmed !== undefined)      rpcParams.unconfirmed = params.unconfirmed;
        if (params.customOutputs !== undefined)    rpcParams.customOutputs = params.customOutputs;

        return this._rpc('create_tx', rpcParams);
    }

    // Broadcast a signed raw transaction hex to the coin node
    //
    // Required:
    //   txHex - signed raw transaction hex (from wallet.signPsbt)
    //
    // Returns: { txid: <string> }
    async broadcastTx(txHex) {
        if (!txHex)
            throw new SDKEncoderError('MISSING_TX_HEX', 'broadcastTx requires txHex (signed transaction hex)');

        return this._rpc('broadcast_tx', { tx_hex: txHex });
    }

    // Estimate fee for a transaction without signing or broadcasting.
    // Calls create_tx and returns the PSBT along with fee information.
    // The returned PSBT can optionally be signed directly to avoid a second encode call.
    //
    // Required: same as createTx (data, pubkey)
    // Returns: { psbt, encoding, fee, inputTotal, outputTotal }
    async estimateFee(params) {
        let result = await this.createTx(params);

        // Parse PSBT to compute fee from inputs vs outputs
        let feeInfo = { psbt: result.psbt, encoding: result.encoding };
        try {
            const bitcoin = require('bitcoinjs-lib');
            let psbt = bitcoin.Psbt.fromHex(result.psbt);

            let inputTotal = 0;
            for (let i = 0; i < psbt.data.inputs.length; i++) {
                let input = psbt.data.inputs[i];
                if (input.witnessUtxo) {
                    inputTotal += input.witnessUtxo.value;
                } else if (input.nonWitnessUtxo) {
                    let tx = bitcoin.Transaction.fromBuffer(input.nonWitnessUtxo);
                    let prevIndex = psbt.txInputs[i].index;
                    inputTotal += tx.outs[prevIndex].value;
                }
            }

            let outputTotal = 0;
            let txOutputs = psbt.txOutputs;
            for (let out of txOutputs) {
                outputTotal += out.value;
            }

            feeInfo.inputTotal  = inputTotal;
            feeInfo.outputTotal = outputTotal;
            feeInfo.fee         = inputTotal - outputTotal;
        } catch (e) {
            // If PSBT parsing fails, still return the raw result
            feeInfo.fee = null;
            feeInfo.parseError = e.message;
        }

        return feeInfo;
    }

    // Fetch UTXOs for an address from the UTXO tracker (via encoder proxy)
    //
    // Required:
    //   address - coin address to query
    //
    // Returns: { utxos: [ { txid, vout, value, scriptPubKey }, ... ] }
    //   scriptPubKey is a non-empty hex string and is REQUIRED when feeding these
    //   UTXOs back into createTx({ utxos }): the encoder's validateUtxoEntry rejects
    //   any entry missing it with a -32602. A real get_utxos response always includes
    //   it; build caller-supplied utxos arrays with the full shape, not just txid/vout/value.
    async getUTXOs(address) {
        if (!address)
            throw new SDKEncoderError('MISSING_ADDRESS', 'getUTXOs requires address');

        return this._rpc('get_utxos', { address: address });
    }

}

module.exports = EncoderClient;
