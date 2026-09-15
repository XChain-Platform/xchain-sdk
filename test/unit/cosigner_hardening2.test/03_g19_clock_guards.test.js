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
const WindowStore = require('../../../src/cosigner/window_store.js');

function tmpStateFile(tag) {
    return path.join(os.tmpdir(), `cosigner2-${tag}-${crypto.randomBytes(6).toString('hex')}.json`);
}

// G19: the rolling window trusts the wall clock.

describe('G19: clock guards', function () {

    it('clamps a future-dated entry instead of letting it outlive the window', function () {
        const stateFile = tmpStateFile('g19-future');
        const now = 1_800_000_000_000;
        fs.writeFileSync(stateFile, JSON.stringify({
            entries: [{ t: now + 90 * 24 * 3600 * 1000, action: 'SEND', tick: 'TOK', amount: '5' }],
            lastSeen: now,
        }));
        const faults = [];
        const store = new WindowStore(stateFile, 24, () => now, { onFault: (m) => faults.push(m) });
        try {
            // Clamped to now, so it still counts against the window (tightening,
            // never loosening) and will age out on schedule.
            expect(store.snapshot().perTick.TOK).to.equal('5');
            expect(faults.join(' ')).to.match(/future/);
        } finally {
            store.release();
            try { fs.unlinkSync(stateFile); } catch (e) { /* ignore */ }
        }
    });

    it('warns when the clock moved backward across a restart', function () {
        const stateFile = tmpStateFile('g19-back');
        const now = 1_800_000_000_000;
        fs.writeFileSync(stateFile, JSON.stringify({
            entries: [], lastSeen: now + 3600 * 1000,
        }));
        const faults = [];
        const store = new WindowStore(stateFile, 24, () => now, { onFault: (m) => faults.push(m) });
        try {
            expect(faults.join(' ')).to.match(/moved BACKWARD/);
        } finally {
            store.release();
            try { fs.unlinkSync(stateFile); } catch (e) { /* ignore */ }
        }
    });

});
describe('G19: clock guards', function () {

    it('records lastSeen so the next start can detect the step', function () {
        const stateFile = tmpStateFile('g19-lastseen');
        const now = 1_800_000_000_000;
        const store = new WindowStore(stateFile, 24, () => now, { init: true });
        store.record({ action: 'SEND', tick: 'TOK', amount: '1' });
        store.release();
        const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        expect(persisted.lastSeen).to.equal(now);
        try { fs.unlinkSync(stateFile); } catch (e) { /* ignore */ }
    });

    it('tolerates ordinary jitter without crying wolf', function () {
        const stateFile = tmpStateFile('g19-jitter');
        const now = 1_800_000_000_000;
        fs.writeFileSync(stateFile, JSON.stringify({
            entries: [{ t: now + 5_000, action: 'SEND', tick: 'TOK', amount: '5' }],
            lastSeen: now + 5_000,
        }));
        const faults = [];
        const store = new WindowStore(stateFile, 24, () => now, { onFault: (m) => faults.push(m) });
        try {
            expect(faults).to.have.length(0);
        } finally {
            store.release();
            try { fs.unlinkSync(stateFile); } catch (e) { /* ignore */ }
        }
    });

});
