/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * XChain Platform SDK - Address Resolver
 *
 * Transaction-size optimization: an address can be referenced on the wire
 * either by its full string (1JDog...) or by its immutable numeric index id
 * with a caret prefix (^57). The id form is almost always smaller. This
 * resolver looks an address up via the explorer, caches the id permanently
 * (index_addresses ids never change once assigned, and they are deterministic
 * + reorg-stable), and substitutes the `^<id>` form into the action before it
 * is serialized. It is the address twin of tickResolver.js.
 *
 * Behavior is opt-out, ON by default: the SDK tries to produce the smallest
 * transaction and falls back to the supplied address whenever the id cannot be
 * resolved (no explorer wired, address not yet indexed, network unreachable).
 * Disable with `new XChainSDK({ compactAddresses: false })`.
 *
 * The SET of compactable fields comes from the SHARED, byte-identical field map
 * src/addressRefFields.js (the indexer keeps the authoritative copy). Compaction
 * is gated per action by SDK_COMPACTABLE_BY_ACTION (single-value, non-type-gated,
 * non-`noCompact` fields); the indexer assigns ids for the FULL set, so the
 * SDK-emitted `^<id>` set is always a subset the indexer recognises. One field is
 * held back even though the indexer ids it: DISPENSER.GET_ADDRESS is emitted as a
 * full address (the decoder gates dispense detection on it and cannot resolve a
 * `^<id>` ref), while ORDER/SWAP.GET_ADDRESS stay compacted. SOURCE is never in
 * the map (it is the tx sender, not a wire payload field) and so is never compacted.
 *
 ********************************************************************/

const { SDK_COMPACTABLE_BY_ACTION } = require('./addressRefFields.js');

// Per-ACTION sets of fields whose value references an EXISTING address and can
// therefore be compacted to the `^<id>` wire form. Derived from the shared
// consensus map so it can never drift from the indexer's accepted set. Keyed by
// action so a field can be compactable for one action yet held back for another
// (DISPENSER.GET_ADDRESS is emitted as a full address; ORDER/SWAP.GET_ADDRESS are
// compacted) — see the `noCompact` note in addressRefFields.js.
const COMPACTABLE_BY_ACTION = SDK_COMPACTABLE_BY_ACTION;

// Hard upper bound on a single compaction lookup. A reachable explorer answers
// in well under this; the cap only matters for a host that accepts a connection
// but never responds, where it bounds the fall-back-to-address latency.
const LOOKUP_CAP_MS = 2500;

class AddressResolver {

    constructor(sdk) {
        this.sdk = sdk;
        // Permanent address -> numeric-id cache. An index_addresses id is immutable
        // once assigned, so entries never need invalidation. Addresses are
        // case-sensitive, so the key is the exact address string; an SDK instance is
        // bound to one network/coin, so ids cannot collide across coins in one cache.
        this.cache = new Map();
    }

    // Compaction is on by default; opt out with { compactAddresses: false }.
    enabled() {
        return this.sdk.options.compactAddresses !== false;
    }

    // Resolve `promise`, but reject if it has not settled within `ms`. The
    // underlying promise's eventual rejection is swallowed so a capped-out
    // lookup never surfaces as an unhandled rejection.
    _withCap(promise, ms) {
        promise.catch(() => {});
        return new Promise((resolve, reject) => {
            let timer = setTimeout(() => reject(new Error('address-lookup timeout')), ms);
            if (timer && typeof timer.unref === 'function') timer.unref();
            promise.then(
                (v) => { clearTimeout(timer); resolve(v); },
                (e) => { clearTimeout(timer); reject(e); }
            );
        });
    }

    // Resolve a single address value to its `^<id>` form when possible. Returns
    // the input unchanged whenever compaction cannot apply: disabled, empty,
    // already an id reference, a contract C:<CHAIN>:<idx> form, the BURN sentinel,
    // no explorer wired, address not yet indexed, or any lookup error. Never
    // throws and never blocks action creation.
    async resolve(address) {
        if (!this.enabled()) return address;
        if (address === undefined || address === null) return address;
        let str = String(address);
        if (str === '') return address;
        if (str.charAt(0) === '^') return address;          // already an id reference
        // Contract-derived addresses (C:<CHAIN>:<idx>) and the DEPLOY BURN sentinel are
        // not plain index_addresses lookups; leave them as-is.
        if (str.charAt(0) === 'C' && str.indexOf(':') !== -1) return address;
        if (str === 'BURN') return address;
        if (this.cache.has(str)) return '^' + this.cache.get(str);
        if (!this.sdk.explorer) return address;             // no explorer: keep the address

        let id = null;
        try {
            // Best-effort lookup: no retry (fail fast and fall back rather than
            // block on backoff) and a hard time cap so a hung host can never stall
            // action generation. Compaction is an optimization, never a dependency.
            let res  = await this._withCap(this.sdk.explorer.getAddress(str, { noRetry: true }), LOOKUP_CAP_MS);
            let info = res && (Array.isArray(res) ? (res[0] || {}).info : res.info);
            if (info && info.address_id !== undefined && info.address_id !== null)
                id = String(info.address_id);
        } catch (e) {
            return address;                                 // unreachable/offline/404/timeout: keep the address
        }

        if (id === null || !/^[0-9]+$/.test(id)) return address;   // not indexed yet / unusable id
        this.cache.set(str, id);
        return '^' + id;
    }

    // Compact every eligible address field of an action's params to its `^<id>`
    // wire form. Returns a SHALLOW COPY with each original key's casing preserved
    // (only the address field VALUES are rewritten); the caller's object is never
    // mutated. Multi-value fields (arrays, e.g. multi-recipient SEND destinations)
    // and type-gated fields (LIST.ITEM) are deliberately skipped: they are absent
    // from SDK_COMPACTABLE, so the indexer assigns their ids in handler order and
    // the SDK never emits a `^<id>` the indexer would not recognise. When
    // compaction is disabled the params pass straight through.
    async resolveActionParams(action, params) {
        if (!this.enabled() || params === undefined || params === null) return params;
        // Gate on THIS action's compactable fields, so a field held back for one
        // action (DISPENSER.GET_ADDRESS) is not compacted just because another
        // action compacts a same-named field. Unknown actions compact nothing.
        let name = String(action || '').toUpperCase();
        let compactable = COMPACTABLE_BY_ACTION[name] || [];
        let out = Object.assign({}, params);
        for (let key of Object.keys(out)) {
            // Map the (possibly camelCase) key to its canonical UPPER_SNAKE name
            // to test whether it is an address-reference field.
            let field = this.sdk.util.camelToUpperSnake(key);
            if (!compactable.includes(field)) continue;
            let val = out[key];
            if (val === undefined || val === null || Array.isArray(val)) continue;
            out[key] = await this.resolve(val);
        }
        return out;
    }
}

module.exports = AddressResolver;
