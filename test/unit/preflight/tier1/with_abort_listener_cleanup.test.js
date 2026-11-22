'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// withAbort must detach its abort listener on every settle path, so a
// caller that keeps one AbortSignal across many pre-flights does not
// accumulate listeners.

const { expect } = require('chai');
const { getEventListeners } = require('events');
const { withAbort } = require('../../../../src/preflight/tier1.js');

const count = (signal) => getEventListeners(signal, 'abort').length;

describe('tier1 withAbort listener cleanup', () => {
    it('returns to zero listeners after resolved, rejected and timed-out calls', async () => {
        const ac = new AbortController();
        for (let i = 0; i < 200; i++) {
            await withAbort(Promise.resolve(i), ac.signal, 1000);
            let err = null;
            await withAbort(Promise.reject(new Error('x')), ac.signal, 1000).catch(e => { err = e; });
            expect(err).to.be.an('error');
            let t = null;
            await withAbort(new Promise(() => {}), ac.signal, 1).catch(e => { t = e; });
            expect(t.message).to.match(/timeout/);
        }
        expect(count(ac.signal)).to.equal(0);
    });

    it('works without a timeout and still detaches', async () => {
        const ac = new AbortController();
        await withAbort(Promise.resolve(1), ac.signal);
        expect(count(ac.signal)).to.equal(0);
    });

    it('aborting after cleanup causes no stray rejection, and abort before settle still rejects', async () => {
        const ac = new AbortController();
        const unhandled = [];
        const h = (e) => unhandled.push(e);
        process.on('unhandledRejection', h);
        try {
            await withAbort(Promise.resolve(1), ac.signal, 1000);
            ac.abort();
            await new Promise(r => setImmediate(r));
            expect(unhandled).to.have.length(0);
            let msg = null;
            await withAbort(new Promise(() => {}), ac.signal, 1000).catch(e => { msg = e.message; });
            expect(msg).to.equal('aborted');
            expect(count(ac.signal)).to.equal(0);
        } finally {
            process.removeListener('unhandledRejection', h);
        }
    });

    it('detaches when aborted mid-flight', async () => {
        const ac = new AbortController();
        const p = withAbort(new Promise(() => {}), ac.signal, 1000);
        expect(count(ac.signal)).to.equal(1);
        ac.abort();
        await p.catch(() => {});
        expect(count(ac.signal)).to.equal(0);
    });
});
