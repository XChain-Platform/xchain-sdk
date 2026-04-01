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

        // Connection pooling configuration
        let pool = options.pool || {};
        this._agent = new (require('http').Agent)({
            keepAlive:      pool.keepAlive !== undefined ? pool.keepAlive : true,
            keepAliveMsecs: pool.keepAliveMsecs || 1000,
            maxSockets:     pool.maxSockets || 10,
            maxFreeSockets: pool.maxFreeSockets || 5
        });

        this.client = axios.create({
            baseURL: 'http://' + this.baseUrl + ':' + this.port,
            timeout: this.timeout,
            headers: { 'Content-Type': 'application/json' },
            httpAgent: this._agent
        });

        this._rpcId = 0;

        // Retry configuration
        this.retry = options.retry !== undefined ? options.retry : {};
        // Hooks
        this.hooks = options.hooks || {};
    }

    // Make a JSON-RPC 2.0 call with retry and hooks
    async _rpc(method, params = {}) {
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
                            { method, rpcError: body.error }
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

    // Handle HTTP/network errors
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

    // Ping the encoder
    async ping() {
        return this._rpc('ping');
    }

    // Create a transaction (main encoding method)
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
    //   change, fee, feePerKb, rbf, dust, unconfirmed
    //
    // Returns: { psbt: <hex>, encoding: <string> }
    async spendP2sh(params) {
        if (!params.pubkey)
            throw new SDKEncoderError('MISSING_PUBKEY', 'spendP2sh requires pubkey');
        if (!params.p2shHash)
            throw new SDKEncoderError('MISSING_P2SH_HASH', 'spendP2sh requires p2shHash');
        if (!params.p2shHex)
            throw new SDKEncoderError('MISSING_P2SH_HEX', 'spendP2sh requires p2shHex');

        let rpcParams = {
            pubkey:  params.pubkey,
            p2shHash: params.p2shHash,
            p2shHex:  params.p2shHex,
            data:     ''  // empty data for spend phase
        };

        if (params.change !== undefined)      rpcParams.change = params.change;
        if (params.fee !== undefined)         rpcParams.fee = params.fee;
        if (params.feePerKb !== undefined)    rpcParams.feePerKb = params.feePerKb;
        if (params.rbf !== undefined)         rpcParams.rbf = params.rbf;
        if (params.dust !== undefined)        rpcParams.dust = params.dust;
        if (params.unconfirmed !== undefined) rpcParams.unconfirmed = params.unconfirmed;

        return this._rpc('create_tx', rpcParams);
    }

}

module.exports = EncoderClient;
