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
 * is serialized. It is the address twin of tick_resolver.js.
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
 * SDK-emitted `^<id>` set is always a subset the indexer recognises. The fields
 * marked `noCompact` in src/addressRefFields.js (the authoritative list and its
 * rationale) are held back even though the indexer ids them, because the decoder
 * keys work off them and cannot resolve a `^<id>` ref. Today that is two fields,
 * both emitted as full addresses: DISPENSER.GET_ADDRESS (the decoder gates dispense
 * detection on it) and DISPENSER.ORACLE_ADDRESS (the decoder captures the oracle-fee
 * output from it, so a compacted ref fails validateOracleFee and the create is
 * rejected). ORDER/SWAP.GET_ADDRESS stay compacted. SOURCE is never in the map (it
 * is the tx sender, not a wire payload field) and so is never compacted.
 *
 ********************************************************************/

const { SDK_COMPACTABLE_BY_ACTION } = require('../addressRefFields.js');
const { activationThreshold } = require('../preflight/activation.js');
const { listAddressRefActive, shouldCompactListItems } = require('./list/address_ref_gate.js');
const { mapWithLimit } = require('./list/map_limit.js');
const { readParentListType } = require('./list/parent_list_type.js');

// Per-ACTION sets of fields whose value references an EXISTING address and can
// therefore be compacted to the `^<id>` wire form. Derived from the shared
// consensus map so it can never drift from the indexer's accepted set. Keyed by
// action so a field can be compactable for one action yet held back for another
// (DISPENSER.GET_ADDRESS and DISPENSER.ORACLE_ADDRESS are emitted as full addresses;
// ORDER/SWAP.GET_ADDRESS are compacted); see the `noCompact` note in addressRefFields.js.
const COMPACTABLE_BY_ACTION = SDK_COMPACTABLE_BY_ACTION;

// Hard upper bound on a single compaction lookup. A reachable explorer answers
// in well under this; the cap only matters for a host that accepts a connection
// but never responds, where it bounds the fall-back-to-address latency.
const LOOKUP_CAP_MS = 2500;
const LIST_ITEM_LOOKUP_LIMIT = 8;

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
    withCap(promise, ms) {
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
            let res  = await this.withCap(this.sdk.explorer.getAddress(str, { noRetry: true }), LOOKUP_CAP_MS);
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

    async compactListItems(out) {
        let fields = {};
        for (let key of Object.keys(out))
            fields[this.sdk.util.camelToUpperSnake(key)] = key;

        let itemKey = fields.ITEM;
        if (itemKey === undefined) return;
        let listType = fields.TYPE === undefined ? null : out[fields.TYPE];
        if (listType !== null && String(listType) !== '2') return;
        let explorer = this.sdk.explorer;
        if (!explorer || typeof explorer.getStatus !== 'function') return;

        let threshold = activationThreshold('LIST_ADDRESS_REF', this.sdk);
        let status;
        try {
            status = await this.withCap(Promise.resolve().then(() => explorer.getStatus()), LOOKUP_CAP_MS);
        } catch (e) {
            return;
        }
        let lastBlock = status && status.last_block && status.last_block[explorer.coin];
        if (!listAddressRefActive(threshold, lastBlock)) return;

        if (listType === null && fields.LIST_ACTION_INDEX !== undefined)
            listType = await readParentListType(
                explorer,
                out[fields.LIST_ACTION_INDEX],
                (promise) => this.withCap(promise, LOOKUP_CAP_MS)
            );
        if (!shouldCompactListItems({ listType, threshold, lastBlock })) return;

        let input = Array.isArray(out[itemKey]) ? out[itemKey] : [out[itemKey]];
        let compacted = await mapWithLimit(input, LIST_ITEM_LOOKUP_LIMIT, async (item) => {
            try {
                return await this.resolve(item);
            } catch (e) {
                return item;
            }
        });
        out[itemKey] = Array.isArray(out[itemKey]) ? compacted : compacted[0];
    }

    // Compact every eligible address field of an action's params to its `^<id>`
    // wire form. Return a SHALLOW COPY with each original key's casing preserved;
    // only address field VALUES are rewritten, so the caller's object is never mutated.

    // Multi-value fields, such as multi-recipient SEND destinations, and type-gated
    // fields are deliberately absent from SDK_COMPACTABLE. The indexer assigns their
    // ids in handler order, so general compaction never emits an unrecognised `^<id>`.

    // LIST.ITEM is the exception: address-list items compact only through the gated
    // path above, after activation and the list's type are known. All other arrays
    // remain untouched. When compaction is disabled, params pass straight through.
    async resolveActionParams(action, params) {
        if (!this.enabled() || params === undefined || params === null) return params;
        // Gate on THIS action's compactable fields, so a field held back for one
        // action (DISPENSER.GET_ADDRESS) is not compacted just because another
        // action compacts a same-named field. Unknown actions compact nothing.
        let name = String(action || '').toUpperCase();
        let compactable = COMPACTABLE_BY_ACTION[name] || [];
        let out = Object.assign({}, params);
        if (name === 'LIST') await this.compactListItems(out);
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
