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
 * Regression: a subscription the explorer never confirms must not take
 * the host process down.
 *
 * The onX() helpers (onBlock, onAddress,...) are synchronous: they return
 * an unsubscribe function, so nothing awaits ws.subscribe()'s SUBSCRIBED
 * confirmation. But subscribe() rejects with WS_TIMEOUT ten seconds later
 * when the explorer is down (503) or the socket drops mid-handshake. With
 * no consumer attached, that rejection is UNHANDLED, and an unhandled
 * rejection terminates the process on Node.
 *
 * Observed as a wallet gate failing roughly one run in three whenever
 * explorer.xchain.io was returning 503: the smoke process was killed
 * outright, ten seconds after a subscribe nobody was waiting on.
 */
'use strict';

const { expect }  = require('chai');
const XChainSDK   = require('../../src/XChainSDK.js');

// A ws double whose subscribe() never gets confirmed.
function rejectingWs(err) {
    return {
        subscribe() { return Promise.reject(err); },
        on() {},
        off() {},
        unsubscribe() {},
    };
}

describe('WS subscribe: detached rejections', () => {
    let unhandled;
    let onUnhandled;

    beforeEach(() => {
        unhandled = [];
        onUnhandled = (reason) => unhandled.push(reason);
        process.on('unhandledRejection', onUnhandled);
    });

    afterEach(() => {
        process.removeListener('unhandledRejection', onUnhandled);
    });

    // Lets any unhandled rejection actually fire before we assert. Node reports
    // an unhandled rejection once the microtask queue has drained for the current
    // turn, so two macrotask hops is the DEFINED point by which a missed rejection
    // would already have been delivered. The old fixed 50ms was that same wait,
    // guessed at: slower than it needs to be and still not a guarantee.
    const settle = async () => {
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
    };

    it('swallows an unconfirmed subscription instead of crashing the process', async () => {
        const sdk = Object.create(XChainSDK.prototype);
        const err = new Error('No response for request id: sub-1');

        expect(() => sdk._subscribeDetached(rejectingWs(err), ['blocks'])).to.not.throw();

        await settle();
        expect(unhandled, 'an orphaned subscribe rejection escaped').to.deep.equal([]);
    });

    it('survives a subscribe() that throws synchronously', async () => {
        const sdk = Object.create(XChainSDK.prototype);
        const throwingWs = {
            subscribe() { throw new Error('socket already closed'); },
            on() {}, off() {}, unsubscribe() {},
        };

        expect(() => sdk._subscribeDetached(throwingWs, ['address'], { address: 'x' }))
            .to.not.throw();

        await settle();
        expect(unhandled).to.deep.equal([]);
    });

    it('still lets a caller who awaits subscribe() see the rejection', async () => {
        // The detached path must not change ws.subscribe()'s own contract:
        // code that awaits confirmation still gets its error.
        const err = new Error('No response for request id: sub-2');
        let caught = null;
        try {
            await rejectingWs(err).subscribe(['blocks']);
        } catch (e) {
            caught = e;
        }
        expect(caught).to.equal(err);
    });
});
