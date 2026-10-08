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
const { SDKEncoderError, SDKRateLimitedError } = require('../utils/errors.js');
const { withRetry, isRetryable, getRetryAfterSeconds } = require('../utils/retry.js');
const Config = require('../config.js');
const { hasHttpScheme, isHttpsUrl } = require('../utils/endpoints.js');
const { installMethods } = require('../utils/install_methods.js');
const encoderTransactionMethods = require('./encoder/transactions.js');
const { getTxBlock, ...encoderPrototypeMethods } = encoderTransactionMethods;

// Return the JSON-RPC error object a non-2xx body carries, or null for any other
// body (a proxy's HTML error page, an empty 500).
function rpcErrorFromBody(data) {
    let rpcError = data && typeof data === 'object' ? data.error : null;
    if (!rpcError || typeof rpcError !== 'object' || typeof rpcError.message !== 'string') return null;
    return rpcError;
}

// Format the encoder's reason and JSON-RPC code as a message suffix.
function rpcErrorSuffix(rpcError) {
    if (!rpcError) return '';
    return ': ' + rpcError.message + (typeof rpcError.code === 'number' ? ' (code ' + rpcError.code + ')' : '');
}

// Build the withRetry callback that reports one rpc call's retries, or null when
// the client has no onRetry hook.
function encoderRetryHook(client, method) {
    if (!client.hooks.onRetry) return null;
    return (attempt, delay, err) => {
        // `status` lets a hook tell a rate limit from a 5xx without parsing
        // the message; null for a transport error that never got a response.
        client.hooks.onRetry({
            service: 'encoder', method, attempt, delay, error: err.message,
            status: err.response ? err.response.status : null,
            rpcCode: null
        });
    };
}

class EncoderClient {

    constructor(options = {}) {
        this.baseUrl = options.encoderUrl || 'localhost';
        this.port    = options.encoderPort || 3003;
        this.timeout = options.timeout || 30000;
        this._pool   = options.pool || {};

        // Lazy-readiness hook (awaited once before the first request so the SDK
        // can overlay hub-discovered endpoints). No-op when not supplied.
        this._readyHook = options.readyHook || null;

        // Optional encoder API key, mirroring HubConnector's hubApiKey. An
        // xchain-encoder whose operator set API_KEY 401s every method except
        // GET /openrpc.json, so without this the SDK could not talk to a keyed
        // deployment at all. Read here rather than per request because
        // buildClient() is also the hub-discovery rebuild path, and a header
        // attached at call time would have to be re-derived there. Guarded for
        // browser bundles where process is undefined. Note the exposure this
        // buys: with no pinned encoderUrl the hub overlay repoints the client,
        // and the key then goes to whatever encoder host the hub named.
        this.apiKey = options.encoderApiKey ||
            Config.env.encoderApiKey() || '';

        // Build the pooled axios client for the current baseUrl/port.
        this.buildClient();

        this._rpcId = 0;

        // Retry configuration
        this.retry = options.retry !== undefined ? options.retry : {};
        // Hooks
        this.hooks = options.hooks || {};

        Object.defineProperty(this, 'getTxBlock', {
            value: getTxBlock.bind(this),
            writable: true,
            configurable: true
        });
    }

    // (Re)build the axios client + keep-alive agent for the current target.
    // Picks an https agent for https bases (axios ignores httpAgent on https),
    // so connection pooling applies to public hosts too.
    buildClient() {
        let pool    = this._pool;
        let baseURL = hasHttpScheme(this.baseUrl) ? this.baseUrl : 'http://' + this.baseUrl + ':' + this.port;
        let isHttps = isHttpsUrl(baseURL);
        // An injected agent wins. The desktop wallet routes its traffic
        // through a SOCKS5 proxy when the user turns on Tor routing, and
        // that is expressed as pre-built agents because a SOCKS tunnel is a
        // different way of opening the socket, not a pool tuning knob.
        // http and https are separate because axios needs the matching one.
        // Everything else keeps the pooled default, unchanged.
        let Agent   = isHttps ? require('https').Agent : require('http').Agent;
        this._agent = (isHttps ? pool.httpsAgent : pool.httpAgent) || new Agent({
            keepAlive:      pool.keepAlive !== undefined ? pool.keepAlive : true,
            keepAliveMsecs: pool.keepAliveMsecs || 1000,
            maxSockets:     pool.maxSockets || 10,
            maxFreeSockets: pool.maxFreeSockets || 5
        });
        // Only send x-api-key when one is configured: an empty header value is
        // still a header, and a keyed encoder would compare against it.
        let headers = { 'Content-Type': 'application/json' };
        if (this.apiKey) headers['x-api-key'] = this.apiKey;
        this.client = axios.create({
            baseURL: baseURL,
            proxy: false,
            timeout: this.timeout,
            headers: headers,
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
        this.buildClient();
    }

    async rpc(method, params = {}, options = {}) {
        if (this._readyHook) await this._readyHook();
        let self = this;
        let retryConfig = this.retry === false || options.retry === false
            ? { maxRetries: 0 }
            : this.retry;
        let onRetry = encoderRetryHook(this, method);

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
                            { method, rpcError: body.error, context: body.error.data || null, retryable: false }
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
                    self.handleError(err, method);
                }
            }, retryConfig, onRetry);
        } catch (err) {
            // After all retries, wrap any raw (non-SDK) error into a typed SDKEncoderError
            if (err instanceof SDKEncoderError) throw err;
            self.handleError(err, method);
        }
    }

    handleError(err, method) {
        if (err.response) {
            // Keep the encoder's own JSON-RPC error off a non-2xx body (401 -32001,
            // 429 -32029, 400 -32600) in the same details fields a 2xx error uses.
            let rpcError = rpcErrorFromBody(err.response.data);
            let rpcDetails = rpcError ? { rpcError, context: rpcError.data || null } : {};
            // A 429 reaching here already survived retry.js's honoured wait, so
            // it is the caller's to handle. The "Encoder returned HTTP 429 for
            // method <method>" prefix stays byte-exact for integrators matching
            // on it.
            if (err.response.status === 429) {
                let seconds = getRetryAfterSeconds(err);
                throw new SDKRateLimitedError(
                    'Encoder returned HTTP 429 for method ' + method + (seconds === null ? '' : '; retry after ' + seconds + ' seconds'),
                    Object.assign({ service: 'encoder', status: 429, retryAfterSeconds: seconds, method, data: err.response.data }, rpcDetails)
                );
            }
            // Keep the ENCODER_HTTP_<status> code and message prefix that callers
            // classify on; the encoder's reason rides after them.
            throw new SDKEncoderError(
                'ENCODER_HTTP_' + err.response.status,
                'Encoder returned HTTP ' + err.response.status + ' for method ' + method + rpcErrorSuffix(rpcError),
                Object.assign({ method, status: err.response.status, data: err.response.data }, rpcDetails)
            );
        }
        if (err.code === 'ECONNABORTED') {
            throw new SDKEncoderError('ENCODER_TIMEOUT', 'Encoder request timed out', { method, timeout: this.timeout });
        }
        throw new SDKEncoderError('ENCODER_NETWORK', 'Encoder request failed: ' + err.message, { method, error: err.message });
    }

    async ping() {
        return this.rpc('ping');
    }

    // Reports whether the encoder's hard dependencies are healthy. The
    // tracker_reachable / tracker_synced / tracker_lag fields tell the caller
    // whether the encoder can actually build transactions; a green ping() does
    // not guarantee a reachable UTXO tracker. Maps to the encoder's `health` RPC.
    async health() {
        return this.rpc('health');
    }

    // Returns suggested fee tiers (base-unit per vByte: sat/litoshi/koinu) from
    // the coin node's estimatesmartfee at three confirmation targets: low (6
    // blocks), medium (3 blocks), high (1 block). Use the chosen tier's value as
    // feePerKb (multiply by 1000) when calling createTx. Maps to encoder `estimate_fee`.
    // Note: this is distinct from estimateFee(), which builds a tx and parses the PSBT
    // to compute the actual fee amount of that specific transaction.
    async getFeeTiers() {
        return this.rpc('estimate_fee');
    }

}

installMethods(EncoderClient.prototype, encoderPrototypeMethods);

// The optional createTx fields, named ONCE. Both high-level entry points
// (sdk.createAction and LifecycleManager.submitAction) used to re-enumerate this
// list by hand, and each had silently fallen behind createTx: feeQuote, compress,
// options and sourceAddress were dropped on the floor, so a high-level caller lost
// its protocol-fee output, its FILE compression policy, its Taproot signer
// capability and its source-address UTXO selection with no error at all (a dropped
// feeQuote mines a transaction protocol validation then rejects, burning the miner
// fee). Adding a field to createTx means adding it here, and both callers get it.
EncoderClient.CREATE_TX_OPTION_FIELDS = [
    'change', 'utxos', 'rawData', 'encoding', 'fee', 'feePerKb', 'rbf', 'dust',
    'unconfirmed', 'compressedPubKey', 'customOutputs', 'attachPrevTx',
    'feeQuote', 'compress', 'options', 'sourceAddress'
];

// Copy the caller's SET createTx options onto `into` (a fresh object by default).
// Undefined stays absent: createTx's own mapper reads absent and explicit-false as
// different wire meanings (compress is tri-state), so copying undefined through
// would change what the encoder is asked for.
EncoderClient.pickCreateTxOptions = function (src, into) {
    const out = into || {};
    if (!src) return out;
    for (const key of EncoderClient.CREATE_TX_OPTION_FIELDS)
        if (src[key] !== undefined) out[key] = src[key];
    return out;
};

module.exports = EncoderClient;
