// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect } = require('chai');

const fs      = require('fs');

const os      = require('os');

const path    = require('path');

const crypto  = require('crypto');
const { secp256k1 } = require('@noble/curves/secp256k1.js');

const WindowStore = require('../../../../src/cosigner/window_store.js');
const CoSigner = require('../../../../src/cosigner/co_signer.js');

describe('WindowStore (fail-closed budget)', function () {
    let stateFile;
    beforeEach(() => { stateFile = path.join(os.tmpdir(), `ws-${crypto.randomBytes(6).toString('hex')}.json`); });
    afterEach(() => { try { fs.unlinkSync(stateFile); } catch (e) { /* ignore */ } });

    it('snapshots an empty window before any record', function () {
        const s = new WindowStore(stateFile, 24, null, { init: true });
        expect(s.snapshot()).to.deep.equal({ count: 0, perTick: {} });
    });

    it('accumulates per-tick totals and counts', function () {
        const s = new WindowStore(stateFile, 24, null, { init: true });
        s.record({ action: 'SEND', tick: 'TOK', amount: '5' });
        s.record({ action: 'SEND', tick: 'TOK', amount: '7' });
        const snap = s.snapshot();
        expect(snap.count).to.equal(2);
        expect(snap.perTick.TOK).to.equal('12');
    });

    it('prunes entries older than the window', function () {
        let t = 1_000_000_000_000;
        const s = new WindowStore(stateFile, 1, () => t, { init: true });   // 1-hour window, injected clock
        s.record({ action: 'SEND', tick: 'TOK', amount: '5' });
        t += 2 * 3600 * 1000;                               // advance 2h
        // reload from disk so the in-memory cache doesn't mask pruning. The store
        // is a single-writer resource (G5), so the first handle must hand the lock
        // over before a second one can open the same file.
        s.release();
        const s2 = new WindowStore(stateFile, 1, () => t, { init: true });
        expect(s2.snapshot().count).to.equal(0);
    });

    it('fails closed on a corrupt state file (never silently resets the budget)', function () {
        fs.writeFileSync(stateFile, '{ not valid json');
        // The store loads EAGERLY since G6, so a corrupt window is a startup
        // failure the operator sees at boot rather than a surprise on the first
        // co-sign request. init:true does not paper over it: the file exists, it
        // is simply unreadable, and silently resetting it would re-open the budget.
        expect(() => new WindowStore(stateFile, 24, null, { init: true })).to.throw(/unreadable/);
    });

    it('refuses to start when the state file is ABSENT (deletion is not a reset)', function () {
        // Without init, a missing window is a hard error: treating it as empty
        // made `rm window.json` a complete, silent budget reset (G6).
        let err = null;
        try { new WindowStore(stateFile, 24); } catch (e) { err = e; }
        expect(err).to.not.equal(null);
        expect(err.code).to.equal('WINDOW_STATE_MISSING');
    });
});

describe('WindowStore (window length identity)', function () {
    let stateFile;
    beforeEach(() => { stateFile = path.join(os.tmpdir(), `ws-${crypto.randomBytes(6).toString('hex')}.json`); });
    afterEach(() => { try { fs.unlinkSync(stateFile); } catch (e) { /* ignore */ } });

    it('pins hours in state and refuses to reopen with a different window', function () {
        const first = new WindowStore(stateFile, 24, null, { init: true });
        expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).hours).to.equal(24);
        first.release();
        let error;
        try { new WindowStore(stateFile, 1); } catch (e) { error = e; }
        expect(error.code).to.equal('WINDOW_HOURS_MISMATCH');
        const correct = new WindowStore(stateFile, 24);
        correct.release();
    });

    it('migrates a legacy state and rejects a store-policy mismatch', function () {
        fs.writeFileSync(stateFile, JSON.stringify({ entries: [], lastSeen: Date.now() }));
        const store = new WindowStore(stateFile, 1);
        expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).hours).to.equal(1);
        const a = crypto.randomBytes(32), b = crypto.randomBytes(32);
        const config = { secretKey: b,
            publicKeys: [secp256k1.getPublicKey(a, true), secp256k1.getPublicKey(b, true)],
            policy: { allowedActions: new Set(['SEND']), maxPerWindow: { hours: 24, maxActions: 5 } },
            windowStore: store };
        let error;
        try { new CoSigner(config); } catch (e) { error = e; }
        expect(error.code).to.equal('WINDOW_HOURS_MISMATCH');
        store.release();
    });
});


