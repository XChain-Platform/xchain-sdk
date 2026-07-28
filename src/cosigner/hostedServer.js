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
 * XChain Platform SDK - Hosted (multi-tenant) Co-Signer
 *
 * The local sidecar (server.js) serves ONE account over loopback with one
 * shared bearer token. This serves MANY accounts, over a network, which
 * changes the threat model in three ways that are handled here explicitly:
 *
 *   1. TENANT ISOLATION. Each tenant gets its own CoSigner - its own daemon
 *      key, its own policy, its own window store. A request never NAMES a
 *      tenant: the bearer token alone selects one, so there is no identifier
 *      a caller could tamper with to reach another tenant's daemon, and no
 *      enumeration surface. A token that matches nothing is indistinguishable
 *      from a token whose tenant is disabled.
 *
 *   2. TRANSPORT. Loopback made cleartext survivable; a network listener does
 *      not. `listen()` REFUSES to bind a non-loopback host without TLS, so the
 *      bearer token (which is spending authority) and every transaction's
 *      metadata cannot be shipped in the clear by accident.
 *
 *   3. WIRE VERSION. The loopback wire has no version field because both ends
 *      ship together. A hosted endpoint outlives its clients, so /v1/cosign
 *      requires an explicit `version` and refuses anything it does not
 *      implement, rather than guessing at a shape.
 *
 * Two gates that were hardening on the sidecar are PREREQUISITES here, and are
 * asserted at construction rather than assumed:
 *
 *   - G5's single-writer lock. One tenant per window store, and no two tenants
 *     may share one: two tenants writing one store would erase each other's
 *     budget wholesale. Distinct CoSigner instances are required per tenant.
 *   - G14's input cap. On loopback a wedged daemon inconveniences its own
 *     agent; here it denies service to every OTHER tenant in the process, so
 *     the cap must be set.
 *
 * HONEST LIMITS, because a hosted deployment will meet them:
 *   - Node is single-threaded and signing is CPU-bound, so tenants share one
 *     core. The per-tenant in-flight cap below bounds how much of it any one
 *     tenant can hold, but it is not fair scheduling and is not a substitute
 *     for running large tenants in their own process.
 *   - This adds no billing, quota, audit export, or key custody. The daemon
 *     keys are held in memory by whoever constructs the tenants.
 *   - Denials are logged, not persisted (same as the sidecar, G17).
 *
 ********************************************************************/

'use strict';

const crypto  = require('crypto');
const express = require('express');
const { safeTokenEqual } = require('../utils/safeCompare.js');

// The wire versions this endpoint implements. A request MUST name one.
const SUPPORTED_WIRE_VERSIONS = new Set([1]);

// Hosts that do not require TLS, because the traffic never leaves the machine.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

// Default ceiling on concurrent in-flight requests per tenant (see HONEST LIMITS).
const DEFAULT_MAX_INFLIGHT_PER_TENANT = 4;

function sha256(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }

/*
 * Build the hosted app.
 *
 * @param {object} opts
 *   tenants  [{ id, token, coSigner }]  one entry per served account. `token`
 *            is that tenant's bearer credential and MUST be unique; `coSigner`
 *            is a fully-configured CoSigner (its own key, policy, window store).
 *   maxInflightPerTenant {number}  default 4
 *   logger   {function}  (level, message, context) sink; defaults to console
 * @returns {express.Express} with a `.listenSecure()` helper attached
 */
function createHostedCoSignerApp(opts = {}) {
    const tenants = Array.isArray(opts.tenants) ? opts.tenants : null;
    if (!tenants || tenants.length === 0)
        throw new Error('createHostedCoSignerApp requires a non-empty tenants array');

    const maxInflight = (opts.maxInflightPerTenant === undefined || opts.maxInflightPerTenant === null)
        ? DEFAULT_MAX_INFLIGHT_PER_TENANT : Number(opts.maxInflightPerTenant);
    if (!Number.isInteger(maxInflight) || maxInflight < 1)
        throw new Error('maxInflightPerTenant must be a positive integer');

    const sink = typeof opts.logger === 'function' ? opts.logger : null;
    const log = (level, message, context) => {
        if (sink) {
            try { sink(level, message, context); return; } catch (e) { /* a log sink must never break enforcement */ }
        }
        const line = `[cosigner-hosted] ${message}` + (context ? ' ' + JSON.stringify(context) : '');
        if (level === 'error') console.error(line); else console.warn(line);
    };

    // byTokenHash keys on sha256(token) so tenant selection is a single hash
    // lookup rather than a walk comparing against every tenant's secret. The
    // full-token constant-time compare still runs afterwards, so a hash
    // collision alone cannot authenticate.
    const byTokenHash = new Map();
    const seenIds = new Set();
    const seenStores = new Set();

    for (const [i, t] of tenants.entries()) {
        if (!t || typeof t.id !== 'string' || t.id.length === 0)
            throw new Error(`tenants[${i}] needs a non-empty string id`);
        if (seenIds.has(t.id)) throw new Error(`duplicate tenant id "${t.id}"`);
        seenIds.add(t.id);

        if (typeof t.token !== 'string' || t.token.length < 16)
            throw new Error(`tenants[${i}] ("${t.id}") needs a token of at least 16 characters; ` +
                'it is that tenant\'s entire spending authority');
        if (!t.coSigner || typeof t.coSigner.process !== 'function')
            throw new Error(`tenants[${i}] ("${t.id}") needs a configured CoSigner instance`);

        // G5 as a prerequisite: two tenants sharing one window store would
        // alternately erase each other's consumption history, silently
        // re-opening both budgets. The file store's own lock cannot catch this,
        // because both live in ONE process and one of them legitimately holds it.
        const store = t.coSigner.windowStore;
        if (store) {
            if (seenStores.has(store))
                throw new Error(`tenants[${i}] ("${t.id}") shares a window store with another tenant; ` +
                    'each tenant MUST own its store or they erase each other\'s spending budget');
            seenStores.add(store);
        }

        // G14 as a prerequisite: on loopback a wedged daemon inconveniences only
        // its own agent, but here it starves every other tenant in the process.
        if (!Number.isInteger(t.coSigner.maxCosignInputs) || t.coSigner.maxCosignInputs < 1)
            throw new Error(`tenants[${i}] ("${t.id}") has no maxCosignInputs cap; it is required for a ` +
                'hosted deployment, where one oversized request denies service to every other tenant');

        const hash = sha256(t.token);
        if (byTokenHash.has(hash)) throw new Error(`two tenants share a bearer token ("${t.id}")`);
        byTokenHash.set(hash, { id: t.id, token: t.token, coSigner: t.coSigner, inflight: 0 });
    }

    const app = express();
    app.use(express.json({ limit: '256kb' }));

    app.post('/v1/cosign', (req, res) => {
        const auth = req.get('authorization') || '';
        const presented = auth.startsWith('Bearer ') ? auth.slice(7) : null;

        // Resolve the tenant from the token alone. A caller cannot name a tenant,
        // so there is nothing to tamper with and nothing to enumerate: an unknown
        // token and a known-but-wrong token produce the identical answer.
        const tenant = presented ? byTokenHash.get(sha256(presented)) : undefined;
        if (!tenant || !safeTokenEqual(presented, tenant.token)) {
            log('warn', 'hosted co-sign request rejected: bad bearer token', { presented: presented !== null });
            return res.status(401).json({ approved: false, reason: 'UNAUTHORIZED' });
        }

        const body = req.body || {};

        // A hosted endpoint outlives its clients, so the wire shape is explicit.
        if (!SUPPORTED_WIRE_VERSIONS.has(body.version)) {
            log('warn', 'hosted co-sign request rejected: unsupported wire version',
                { tenant: tenant.id, version: body.version });
            return res.status(400).json({ approved: false, reason: 'UNSUPPORTED_WIRE_VERSION',
                detail: `this endpoint implements version(s) ${[...SUPPORTED_WIRE_VERSIONS].join(', ')}` });
        }

        if (typeof body.psbt !== 'string' || !Array.isArray(body.inputs) || body.inputs.length === 0) {
            log('warn', 'hosted co-sign request rejected: malformed body', { tenant: tenant.id });
            return res.status(400).json({ approved: false, reason: 'BAD_REQUEST',
                detail: 'psbt (hex) and a non-empty inputs[] of { index, agentPublicNonce } are required' });
        }

        // Bound how much of the single shared core one tenant can hold at once.
        if (tenant.inflight >= maxInflight) {
            log('warn', 'hosted co-sign request rejected: tenant is at its in-flight cap',
                { tenant: tenant.id, maxInflight });
            return res.status(429).json({ approved: false, reason: 'TENANT_BUSY',
                detail: `at most ${maxInflight} concurrent requests per tenant` });
        }

        tenant.inflight++;
        let result;
        try {
            result = tenant.coSigner.process({
                psbt: body.psbt, inputs: body.inputs, sighashType: body.sighashType,
            });
        } catch (e) {
            log('error', 'internal fault while processing a hosted co-sign request', {
                tenant: tenant.id, message: e && e.message, code: e && e.code, stack: e && e.stack,
            });
            return res.status(500).json({ approved: false, reason: 'INTERNAL_ERROR', version: body.version });
        } finally {
            tenant.inflight--;
        }

        if (result && result.approved !== true)
            log('warn', 'hosted co-sign request denied',
                { tenant: tenant.id, reason: result.reason, detail: result.detail });

        return res.status(200).json(Object.assign({ version: body.version }, result));
    });

    /*
     * Bind the app, refusing an insecure network listener.
     *
     * @param {object} args  { port, host, tls: { key, cert, ... } }
     * @returns {http.Server|https.Server}
     */
    app.listenSecure = function listenSecure(args = {}) {
        const host = args.host || '127.0.0.1';
        const tls  = args.tls || null;
        const loopback = LOOPBACK_HOSTS.has(host);

        if (!loopback && !tls)
            throw new Error(`refusing to bind ${host} without TLS: the bearer token IS spending authority ` +
                'and every request carries transaction metadata, so a cleartext network listener leaks both. ' +
                'Pass { tls: { key, cert } }, or bind 127.0.0.1 and terminate TLS in front.');
        if (tls && (!tls.key || !tls.cert))
            throw new Error('tls needs both key and cert');

        if (tls) {
            const https = require('https');
            return https.createServer(tls, app).listen(args.port, host, args.onListening);
        }
        return app.listen(args.port, host, args.onListening);
    };

    return app;
}

module.exports = { createHostedCoSignerApp, SUPPORTED_WIRE_VERSIONS, DEFAULT_MAX_INFLIGHT_PER_TENANT };
