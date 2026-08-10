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
 * XChain SDK tests - deterministic waiting
 *
 * Replaces `await new Promise(r => setTimeout(r, 50))` between an event and the
 * assertion about it. A fixed sleep is wrong in both directions at once: it is
 * dead time on a fast machine and a false failure on a loaded one, and the
 * failure it produces ("expected false to be true") never says the wait was the
 * problem. waitFor() polls the real condition and fails with what it was
 * waiting for.
 *
 * A NEGATIVE assertion (this callback must NOT fire) cannot be polled - there is
 * no condition to wait for - so use a BARRIER instead: send a second frame that
 * is observably handled, wait for that, and the earlier frame is then known to
 * have been processed, because a WebSocket delivers in order over one socket.
 * That is deterministic where a sleep only makes the race less likely.
 *
 ********************************************************************/

'use strict';

// Poll `predicate` until it returns truthy. Rejects with `message` on timeout so
// a failure names the condition instead of surfacing as a bare assertion miss.
async function waitFor(predicate, opts = {}) {
    const timeout  = opts.timeout  !== undefined ? opts.timeout  : 2000;
    const interval = opts.interval !== undefined ? opts.interval : 2;
    const message  = opts.message  || 'condition never became true';
    const deadline = Date.now() + timeout;
    for (;;) {
        if (await predicate()) return;
        if (Date.now() >= deadline)
            throw new Error('waitFor timed out after ' + timeout + 'ms: ' + message);
        await new Promise(r => setTimeout(r, interval));
    }
}

// Wait until `spy` (a sinon spy) has been called at least `times` times.
function waitForCalls(spy, times = 1, opts = {}) {
    return waitFor(() => spy.callCount >= times, Object.assign({
        message: 'spy was called ' + spy.callCount + ' time(s), expected at least ' + times
    }, opts));
}

module.exports = { waitFor, waitForCalls };
