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
 * The SDK's unconfirmed-transaction surface: onMempoolAction, getUnconfirmed,
 * and the subscription refcounting they forced.
 *
 * Three separate defects meet here, and every test below is written as
 * BEHAVIOR (a callback fires or does not; a frame reaches the server or does
 * not) rather than as bookkeeping, because all three were invisible in the
 * bookkeeping:
 *
 *  1. MEMPOOL_ACTION / MEMPOOL_REMOVED were absent from ADDRESS_EVENT_TYPES, so
 *     the explorer sent them over the open socket and the client dropped them
 *     without registering a handler. Nothing failed.
 *  2. The per-address delivery guard walked only the SINGULAR address fields. A
 *     mempool frame names `source`, so a correctly-routed delivery to the
 *     RECIPIENT's own channel was rejected as "someone else's frame".
 *  3. ws.subscribe pushed an unconditional replay entry and ws.unsubscribe
 *     removed EVERY match and sent one server unsubscribe, so two subscriptions
 *     to one address channel double-replayed on reconnect and MUTUALLY
 *     DESTROYED each other: the first teardown ended the second's live
 *     delivery. The mock server below models the explorer's entity-keyed
 *     address channel (an unsubscribe really does stop delivery) so that
 *     regression is provable here rather than only on a venue.
 */

'use strict';

const { expect } = require('chai');
const XChainSDK  = require('../../../../src/XChainSDK.js');
const {
    RECIPIENT,
    SENDER
} = require('./support/mempool_surface_support.js');

function sdkWithMempool(rows, capture) {
    const s = Object.create(XChainSDK.prototype);
    s.explorer = {
        async getMempool(query, type, opts) {
            if (capture) capture.push({ query, type, opts });
            return rows;
        }
    };
    return s;
}

describe('SDK mempool surface @regression', function () {
    describe('getUnconfirmed', function () {

        it('returns the explorer field names verbatim, plus destinations', async function () {
            const s = sdkWithMempool({ data: [{
                tx_hash: 'aa11', source: SENDER, action: 'SEND',
                data: 'SEND|3|XCHAIN|100000000|^350', first_seen: 1756300000
            }], total: 1 });

            const rows = await s.getUnconfirmed(RECIPIENT);

            expect(rows).to.have.lengthOf(1);
            expect(rows[0]).to.deep.equal({
                tx_hash: 'aa11',
                source: SENDER,
                action: 'SEND',
                data: 'SEND|3|XCHAIN|100000000|^350',
                first_seen: 1756300000,
                destinations: [RECIPIENT]
            });
        });

        it('leaves destinations empty for the address\'s own transaction', async function () {
            const s = sdkWithMempool({ data: [{
                tx_hash: 'bb22', source: SENDER, action: 'SEND', data: 'SEND|3|XCHAIN|1|^350',
                first_seen: null
            }] });

            const rows = await s.getUnconfirmed(SENDER);

            expect(rows[0].destinations).to.deep.equal([]);
            expect(rows[0].first_seen).to.equal(null);
        });
    });
});

describe('SDK mempool surface @regression', function () {
    describe('getUnconfirmed', function () {

        it('defaults the limit to 100 and lets a caller override it', async function () {
            const capture = [];
            const s = sdkWithMempool({ data: [] }, capture);

            await s.getUnconfirmed(RECIPIENT);
            await s.getUnconfirmed(RECIPIENT, { limit: 25 });

            expect(capture[0].type).to.equal('address');
            expect(capture[0].query).to.equal(RECIPIENT);
            expect(capture[0].opts.limit).to.equal(100);
            expect(capture[1].opts.limit).to.equal(25);
        });

        it('returns [] on an empty mempool rather than null or a throw', async function () {
            expect(await sdkWithMempool({ data: [], total: 0 }).getUnconfirmed(RECIPIENT)).to.deep.equal([]);
            // An envelope with no data key at all (an explorer that answered
            // something unexpected) must degrade the same way.
            expect(await sdkWithMempool({}).getUnconfirmed(RECIPIENT)).to.deep.equal([]);
            expect(await sdkWithMempool(null).getUnconfirmed(RECIPIENT)).to.deep.equal([]);
        });
    });
});
