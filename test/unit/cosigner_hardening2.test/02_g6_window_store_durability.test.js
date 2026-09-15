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

// G6: the window file's absence is not an empty window.

describe('G6: window-store durability', function () {

    it('refuses to start against a deleted state file', function () {
        // Deleting one file is exactly the reset guarded against elsewhere:
        // no corruption, no warning, full budget restored.
        const stateFile = tmpStateFile('g6-missing');
        const first = new WindowStore(stateFile, 24, null, { init: true });
        first.record({ action: 'SEND', tick: 'TOK', amount: '5' });
        first.release();
        fs.unlinkSync(stateFile);

        let err = null;
        try { new WindowStore(stateFile, 24); } catch (e) { err = e; }
        expect(err).to.not.equal(null);
        expect(err.code).to.equal('WINDOW_STATE_MISSING');
    });

    it('a refused start releases its lock, so the operator can retry after restoring', function () {
        const stateFile = tmpStateFile('g6-lock');
        try { new WindowStore(stateFile, 24); } catch (e) { /* expected */ }
        // The lock must not be left behind by the failed construction.
        expect(fs.existsSync(stateFile + '.lock')).to.equal(false);
        const store = new WindowStore(stateFile, 24, null, { init: true });
        store.release();
        try { fs.unlinkSync(stateFile); } catch (e) { /* ignore */ }
    });

    it('creates the file 0600 on an explicit init', function () {
        const stateFile = tmpStateFile('g6-mode');
        const store = new WindowStore(stateFile, 24, null, { init: true });
        try {
            const mode = fs.statSync(stateFile).mode & 0o777;
            expect(mode).to.equal(0o600);
        } finally {
            store.release();
            try { fs.unlinkSync(stateFile); } catch (e) { /* ignore */ }
        }
    });

    it('an init on an existing window does not wipe it', function () {
        const stateFile = tmpStateFile('g6-existing');
        const first = new WindowStore(stateFile, 24, null, { init: true });
        first.record({ action: 'SEND', tick: 'TOK', amount: '5' });
        first.release();
        const second = new WindowStore(stateFile, 24, null, { init: true });
        try {
            expect(second.snapshot().perTick.TOK).to.equal('5');
        } finally {
            second.release();
            try { fs.unlinkSync(stateFile); } catch (e) { /* ignore */ }
        }
    });
});
