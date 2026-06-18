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
 * XChain Platform SDK - Ticker Resolver
 *
 * Transaction-size optimization: a ticker can be referenced on the wire
 * either by its full text name (JDOG) or by its immutable numeric id with a
 * caret prefix (^1234). The id form is almost always smaller. This resolver
 * looks a ticker name up via the explorer, caches the id permanently (ids
 * never change once assigned), and substitutes the `^<id>` form into the
 * action before it is serialized.
 *
 * Behavior is opt-out, ON by default: the SDK tries to produce the smallest
 * transaction and falls back to the supplied name whenever the id cannot be
 * resolved (no explorer wired, token not yet indexed, network unreachable).
 * Disable with `new XChainSDK({ compactTickers: false })`.
 *
 ********************************************************************/

// Fields across all ACTION formats whose value references an EXISTING token,
// and therefore can be compacted to the `^<id>` wire form (the xchain-indexer
// accepts `^<id>` anywhere it accepts a ticker; see getTickerId()). The
// defining TICK of an ISSUE is deliberately excluded: a brand-new token has no
// id yet, and the SDK validator forbids a `^`-led name on ISSUE.
const TICK_REF_FIELDS = ['TICK', 'GIVE_TICK', 'GET_TICK', 'DIVIDEND_TICK', 'CALLBACK_TICK'];

// Hard upper bound on a single compaction lookup. A reachable explorer answers
// in well under this; the cap only matters for a host that accepts a connection
// but never responds, where it bounds the fall-back-to-name latency.
const LOOKUP_CAP_MS = 2500;

class TickResolver {

    constructor(sdk) {
        this.sdk = sdk;
        // Permanent name -> numeric-id cache. A ticker id (index_tickers.id) is
        // immutable once assigned, so entries never need invalidation. Keyed by
        // lowercase name; an SDK instance is bound to a single network/coin, so
        // ids cannot collide across coins within one cache.
        this.cache = new Map();
    }

    // Compaction is on by default; opt out with { compactTickers: false }.
    enabled() {
        return this.sdk.options.compactTickers !== false;
    }

    // Resolve `promise`, but reject if it has not settled within `ms`. The
    // underlying promise's eventual rejection is swallowed so a capped-out
    // lookup never surfaces as an unhandled rejection.
    _withCap(promise, ms) {
        promise.catch(() => {});
        return new Promise((resolve, reject) => {
            let timer = setTimeout(() => reject(new Error('tick-lookup timeout')), ms);
            if (timer && typeof timer.unref === 'function') timer.unref();
            promise.then(
                (v) => { clearTimeout(timer); resolve(v); },
                (e) => { clearTimeout(timer); reject(e); }
            );
        });
    }

    // Resolve a single ticker value to its `^<id>` form when possible. Returns
    // the input unchanged whenever compaction cannot apply: disabled, empty,
    // already an id reference, no explorer wired, token not yet indexed, or any
    // lookup error. Never throws and never blocks action creation.
    async resolve(tick) {
        if (!this.enabled()) return tick;
        if (tick === undefined || tick === null) return tick;
        let str = String(tick);
        if (str === '') return tick;
        if (str.charAt(0) === '^') return tick;          // already an id reference
        let key = str.toLowerCase();
        if (this.cache.has(key)) return '^' + this.cache.get(key);
        if (!this.sdk.explorer) return tick;             // no explorer: keep the name

        let id = null;
        try {
            // Best-effort lookup: no retry (fail fast and fall back rather than
            // block on backoff) and a hard time cap so a hung host can never
            // stall action generation. Compaction is an optimization, never a
            // dependency.
            let token = await this._withCap(this.sdk.explorer.getToken(str, { noRetry: true }), LOOKUP_CAP_MS);
            let info  = token && (Array.isArray(token) ? (token[0] || {}).info : token.info);
            if (info && info.tick_id !== undefined && info.tick_id !== null)
                id = String(info.tick_id);
        } catch (e) {
            return tick;                                 // unreachable/offline/404/timeout: keep the name
        }

        if (id === null || !/^[0-9]+$/.test(id)) return tick;   // not indexed yet / unusable id
        this.cache.set(key, id);
        return '^' + id;
    }

    // Compact every eligible ticker field of an action's params to its `^<id>`
    // wire form. Returns a SHALLOW COPY with each original key's casing
    // preserved (only the ticker field VALUES are rewritten); the caller's
    // object is never mutated. Normalization of field names stays the inner
    // builder's job, so non-ticker params are byte-for-byte untouched. When
    // compaction is disabled the params pass straight through.
    async resolveActionParams(action, params) {
        if (!this.enabled() || params === undefined || params === null) return params;
        let name = String(action || '').toUpperCase();
        let out  = Object.assign({}, params);
        for (let key of Object.keys(out)) {
            // Map the (possibly camelCase) key to its canonical UPPER_SNAKE name
            // to test whether it is a ticker-reference field.
            let field = this.sdk.util.camelToUpperSnake(key);
            if (!TICK_REF_FIELDS.includes(field)) continue;
            if (name === 'ISSUE' && field === 'TICK') continue;   // defining ticker: no id yet
            let val = out[key];
            if (val === undefined || val === null || Array.isArray(val)) continue;
            out[key] = await this.resolve(val);
        }
        return out;
    }
}

module.exports = TickResolver;
