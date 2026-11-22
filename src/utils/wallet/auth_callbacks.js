// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const ExplorerClient = require('../../clients/explorer.js');
const { getNetwork } = require('../../protocol/networks.js');
const AuthUtils = require('../auth.js');
const { publicDefaults } = require('../endpoints.js');
const { installMethods } = require('../install_methods.js');
const { createMemoryCallbackStore } = require('./callback_store.js');
const { holdingFromBalances } = require('./holdings.js');
const { parseLoginChallenge } = require('./login_challenge.js');

const REQUEST_ID = /^[A-Za-z0-9_-]{22}$/;
const CLAIM = /^[A-Za-z0-9_-]{22}$/;
const defaultStores = new WeakMap();
const fallbackStore = createMemoryCallbackStore();

function defaultStoreFor(receiver) {
    if (!receiver || (typeof receiver !== 'object' && typeof receiver !== 'function')) {
        return fallbackStore;
    }
    let store = defaultStores.get(receiver);
    if (!store) {
        store = createMemoryCallbackStore();
        defaultStores.set(receiver, store);
    }
    return store;
}

function callbackFailure(id, error) {
    return { accepted: false, id: id || null, status: 'rejected', error };
}

function validateStore(store) {
    return store && ['issueNonce', 'takeNonce', 'put', 'get']
        .every((method) => typeof store[method] === 'function');
}

function validateEnvelope(body) {
    if (!body || typeof body !== 'object') return 'Callback body must be an object.';
    if (body.v !== 1) return 'Callback version must be 1.';
    if (typeof body.id !== 'string' || !REQUEST_ID.test(body.id)) {
        return 'Callback id must be a 128-bit base64url value.';
    }
    if (typeof body.method !== 'string' || body.method.length === 0) {
        return 'Callback method is required.';
    }
    if (typeof body.ok !== 'boolean') return 'Callback ok must be boolean.';
    if (body.claim !== undefined && (typeof body.claim !== 'string' || !CLAIM.test(body.claim))) {
        return 'Callback claim must be a 128-bit base64url value.';
    }
    if (body.ok && (!body.result || typeof body.result !== 'object')) {
        return 'A successful callback must contain a result.';
    }
    if (!body.ok && body.error === undefined) return 'A failed callback must contain an error.';
    return null;
}

function balanceRows(response) {
    if (Array.isArray(response)) return response;
    if (response && Array.isArray(response.data)) return response.data;
    throw new TypeError('Explorer balances response must contain a data array');
}

function resolveExplorer(receiver, chainId, options) {
    if (options.explorer && typeof options.explorer.getBalances === 'function') {
        return options.explorer;
    }
    if (receiver && receiver.explorer && typeof receiver.explorer.getBalances === 'function') {
        return receiver.explorer;
    }
    const defaults = publicDefaults(chainId);
    return new ExplorerClient({ network: chainId, explorerUrl: defaults.explorerUrl });
}

async function holdsAtLeast(address, tick, min, options = {}) {
    if (!options || typeof options !== 'object') throw new TypeError('options must be an object');
    if (typeof address !== 'string' || address.length === 0) {
        throw new TypeError('address must be a non-empty string');
    }
    const chainId = options.chainId;
    if (typeof chainId !== 'string' || chainId.length === 0) {
        throw new TypeError('options.chainId is required');
    }
    getNetwork(chainId);
    const explorer = resolveExplorer(this, chainId, options);
    const response = await explorer.getBalances(address);
    return holdingFromBalances(balanceRows(response), tick, min);
}

function loginResult(body) {
    if (body.result.ok === true) return body.result;
    return Object.assign({ ok: true }, body.result);
}

function loginBindings(result, options) {
    const parsed = parseLoginChallenge(result.challenge);
    if (!parsed.ok) return { error: parsed.error };
    return {
        nonce: parsed.parts.nonce,
        expected: {
            appId: options.appId === undefined ? parsed.parts.appId : options.appId,
            origin: options.origin === undefined ? parsed.parts.origin : options.origin,
            nonce: parsed.parts.nonce,
            maxAgeMs: options.maxAgeMs,
        },
    };
}

async function receiveLoginCallback(receiver, body, options, store) {
    const result = loginResult(body);
    const bindings = loginBindings(result, options);
    if (bindings.error) return callbackFailure(body.id, bindings.error);

    const verified = await receiver.verifyLogin(result, bindings.expected);
    if (!verified || verified.valid !== true) {
        return callbackFailure(body.id, verified && verified.error
            ? verified.error
            : 'Login verification failed.');
    }

    const nonce = await store.takeNonce(bindings.nonce);
    if (!nonce) return callbackFailure(body.id, 'Login nonce is invalid, expired, or already used.');

    const claimed = body.claim === undefined && nonce.mode === 'cross-device';
    const status = claimed ? 'approved' : 'approved-unclaimed';
    const record = {
        body,
        verified,
        nonceMode: nonce.mode,
        claim: body.claim || null,
        claimed,
        status,
    };
    await store.put(body.id, record);
    return { accepted: true, id: body.id, status, claimed, verified };
}

async function receiveCallback(body, options = {}) {
    try {
        if (!options || typeof options !== 'object') {
            return callbackFailure(null, 'Callback options must be an object.');
        }
        const envelopeError = validateEnvelope(body);
        if (envelopeError) return callbackFailure(body && body.id, envelopeError);
        const store = options.store || defaultStoreFor(this);
        if (!validateStore(store)) return callbackFailure(body.id, 'Callback store is invalid.');

        if (body.method === 'login' && body.ok) {
            if (!this || typeof this.verifyLogin !== 'function') {
                return callbackFailure(body.id, 'Login verification is unavailable.');
            }
            return await receiveLoginCallback(this, body, options, store);
        }

        const status = body.ok ? 'received' : 'rejected';
        await store.put(body.id, { body, status });
        return { accepted: true, id: body.id, status };
    } catch (error) {
        return callbackFailure(body && body.id, error && error.message
            ? error.message
            : 'Invalid callback.');
    }
}

module.exports = { holdsAtLeast, receiveCallback };
Object.defineProperty(module.exports, 'defaultStoreFor', { value: defaultStoreFor });
installMethods(AuthUtils.prototype, module.exports);
