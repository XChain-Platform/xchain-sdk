// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Coverage contract: the SDK's address-channel and entity-channel wrappers must
// register every frame the explorer actually routes to them.
//
// This exists because onAddress() carried a hand-written eight-name list while
// the explorer's Broadcaster._onLifecycleEvent fans EVERY lifecycle event out to
// the address channel of each address its data names. Nine names had accumulated
// on the producer side (ORDER_EXPIRED, SWAP_EXPIRED, DISPENSER_CLOSED/EXPIRED,
// BET, BET_EXPIRED, BET_CLOSED, ATTESTATION_REQUEST/RESPONSE) that the client
// never registered a handler for, so the server sent those frames over the open
// socket and any callback keyed on msg.type silently never saw them. Nothing
// failed: not the subscribe, not the suite, not the consumer.
//
// A list maintained by hand against another repo's constants drifts by default,
// and the drift is invisible in exactly this way, so reconcile it mechanically
// against the producer rather than against a second copy of the list.
//
// Skipped when the sibling xchain-explorer checkout is absent (standalone
// clone); XCHAIN_REQUIRE_SIBLINGS=1 turns that skip into a failure, and the
// drift-guards CI job (which already checks the explorer out, per .ci-siblings)
// runs it that way.

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const XChainSDK = require('../../src/XChainSDK.js');

const EXPLORER_DIR = process.env.XCHAIN_EXPLORER_DIR
    || path.join(__dirname, '..', '..', '..', 'xchain-explorer');
const CHANGE_DETECTOR = path.join(EXPLORER_DIR, 'src', 'ws', 'ChangeDetector.js');
const CHANNEL_MANAGER = path.join(EXPLORER_DIR, 'src', 'ws', 'ChannelManager.js');

const SIBLING_PRESENT  = fs.existsSync(CHANGE_DETECTOR) && fs.existsSync(CHANNEL_MANAGER);
const REQUIRE_SIBLINGS = process.env.XCHAIN_REQUIRE_SIBLINGS === '1';

describe('address-channel event coverage vs the explorer producer @regression', function () {

    before(function () {
        if (!SIBLING_PRESENT && REQUIRE_SIBLINGS)
            throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but no xchain-explorer checkout at ' + EXPLORER_DIR);
    });

    it('registers every lifecycle type the explorer can route to an address channel', function () {
        if (!SIBLING_PRESENT) return this.skip();

        // The producer's own three emission paths, exported by ChangeDetector for
        // exactly this reconciliation: the action-driven map, the cursor-driven
        // types with no action row, and the ones emitted inline by enrichment.
        const detector = require(CHANGE_DETECTOR);
        const produced = new Set([
            ...Object.values(detector.LIFECYCLE_MAP).flat(),
            ...detector.NON_ACTION_LIFECYCLE_TYPES,
            ...detector.INLINE_LIFECYCLE_TYPES
        ]);
        assert.ok(produced.size > 0, 'read no lifecycle types out of the explorer ChangeDetector');

        const registered = new Set(XChainSDK.ADDRESS_EVENT_TYPES);
        const missing = [...produced].filter(t => !registered.has(t)).sort();
        assert.deepStrictEqual(missing, [],
            'ADDRESS_EVENT_TYPES in src/XChainSDK.js does not register ' + missing.join(', ')
            + '. Broadcaster._onLifecycleEvent routes every lifecycle event to the address '
            + 'channel of each address it names, so these frames are sent and silently dropped.');
    });

    it('registers no name the explorer would reject as an unknown type', function () {
        if (!SIBLING_PRESENT) return this.skip();

        // The other direction: a phantom name in the SDK list is a handler that can
        // never fire, and passing it back as an `opts.types` filter is a subscribe
        // the server rejects outright with INVALID_TYPE.
        const valid = require(CHANNEL_MANAGER).VALID_TYPES;
        assert.ok(valid && valid.size > 0, 'read no VALID_TYPES out of the explorer ChannelManager');

        // The Broadcaster-level frames are not action/lifecycle types and are
        // deliberately absent from the types filter's vocabulary. The two mempool
        // frames belong here for the same reason as NEW_ACTION and
        // ADDRESS_UPDATE: the Broadcaster emits them from the decoder's mempool
        // diff, not from the lifecycle map, and the explorer's `types` filter
        // narrows mempool frames by the row's ACTION name (SEND, ISSUE, ...), so
        // naming the frame type as a subscribe filter would be rejected.
        const BROADCASTER_FRAMES = new Set([
            'NEW_ACTION', 'ADDRESS_UPDATE',
            'MEMPOOL_ACTION', 'MEMPOOL_REMOVED'
        ]);
        const phantom = XChainSDK.ADDRESS_EVENT_TYPES
            .filter(t => !BROADCASTER_FRAMES.has(t) && !valid.has(t)).sort();
        assert.deepStrictEqual(phantom, [],
            'ADDRESS_EVENT_TYPES names ' + phantom.join(', ') + ', which the explorer '
            + 'ChannelManager does not accept as a type.');
    });

    it('wraps every entity channel the explorer serves', function () {
        if (!SIBLING_PRESENT) return this.skip();

        // bet_feed shipped as a first-class entity channel with a dedicated
        // snapshot case while the SDK wrapped only token/market/dispenser, which
        // left consumers hand-rolling the feed_action_index correlation.
        const entityChannels = require(CHANNEL_MANAGER).ENTITY_CHANNELS;
        const WRAPPER_FOR_CHANNEL = {
            address:   'onAddress',
            token:     'onToken',
            market:    'onMarket',
            dispenser: 'onDispenser',
            bet_feed:  'onBetFeed'
        };
        const unwrapped = [...entityChannels]
            .filter(c => typeof XChainSDK.prototype[WRAPPER_FOR_CHANNEL[c]] !== 'function').sort();
        assert.deepStrictEqual(unwrapped, [],
            'the explorer serves entity channel(s) ' + unwrapped.join(', ')
            + ' that XChainSDK has no typed wrapper for.');
    });
});
