// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const {
    expect,
    fs,
    path,
    WindowStore,
    tmpStateFile,
} = require('./helpers/cosigner_hardening_helpers.js');

// G5: single writer is a safety property.

describe('G5: window-store single-writer lock', function () {

    it('refuses a second store on the same state file', function () {
        // Two daemons sharing one store do not merely race a counter: each caches
        // the entry array in memory and rewrites the WHOLE file from that cache,
        // so they alternately discard each other's entire consumption history and
        // silently re-open the full budget.
        const stateFile = tmpStateFile('lock');
        const first = new WindowStore(stateFile, 24, null, { init: true });
        try {
            let err = null;
            try { new WindowStore(stateFile, 24, null, { init: true }); } catch (e) { err = e; }
            expect(err).to.not.equal(null);
            expect(err.code).to.equal('WINDOW_STORE_LOCKED');
            expect(err.holderPid).to.equal(process.pid);
        } finally {
            first.release();
            try { fs.unlinkSync(stateFile); } catch (e) { /* ignore */ }
        }
    });

    it('a released lock can be taken by the next store', function () {
        const stateFile = tmpStateFile('lock-release');
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

describe('G5: window-store single-writer lock', function () {

    // The startup race this closes: create-then-write left the lockfile EXISTING
    // and EMPTY between openSync('wx') and the writeSync that filled it. A second
    // daemon starting in that window parsed no holder, could prove no pid alive,
    // and reclaimed the LIVE lock as stale. Both then held the store, and since
    // each rewrites the whole file from its own cache, they discard each other's
    // consumption history and re-open the full budget with no symptom.
    it('refuses to reclaim a lock whose holder record is empty', function () {
        const stateFile = tmpStateFile('lock-empty');
        // Exactly what an observer saw mid-acquire, and what a power loss can leave.
        fs.writeFileSync(stateFile + '.lock', '');
        let err = null;
        try { new WindowStore(stateFile, 24, null, { init: true }); } catch (e) { err = e; }
        try {
            expect(err, 'an unreadable holder is not proof the lock is stale').to.not.equal(null);
            expect(err.code).to.equal('WINDOW_STORE_LOCKED');
            expect(err.holderPid).to.equal(null);
            expect(err.message).to.contain(stateFile + '.lock');
            expect(fs.existsSync(stateFile + '.lock'), 'the live lock must survive the refusal').to.equal(true);
        } finally {
            try { fs.unlinkSync(stateFile + '.lock'); } catch (e) { /* ignore */ }
            try { fs.unlinkSync(stateFile); } catch (e) { /* ignore */ }
        }
    });

    it('refuses to reclaim a lock whose holder record does not name a pid', function () {
        const stateFile = tmpStateFile('lock-garbage');
        fs.writeFileSync(stateFile + '.lock', JSON.stringify({ t: Date.now() }));
        let err = null;
        try { new WindowStore(stateFile, 24, null, { init: true }); } catch (e) { err = e; }
        try {
            expect(err).to.not.equal(null);
            expect(err.code).to.equal('WINDOW_STORE_LOCKED');
            expect(fs.existsSync(stateFile + '.lock')).to.equal(true);
        } finally {
            try { fs.unlinkSync(stateFile + '.lock'); } catch (e) { /* ignore */ }
            try { fs.unlinkSync(stateFile); } catch (e) { /* ignore */ }
        }
    });
});

describe('G5: window-store single-writer lock', function () {

    // The other half: the lockfile is never observable empty in the first place,
    // because the record is written to a tmp file and hardlinked into place.
    it('never publishes a lock name that is not already complete', function () {
        const stateFile = tmpStateFile('lock-atomic');
        const store = new WindowStore(stateFile, 24, null, { init: true });
        try {
            const raw = fs.readFileSync(stateFile + '.lock', 'utf8');
            expect(raw.length, 'the published lock must carry its holder record').to.be.greaterThan(0);
            expect(JSON.parse(raw).pid).to.equal(process.pid);
            const leftovers = fs.readdirSync(path.dirname(stateFile))
                .filter(f => f.startsWith(path.basename(stateFile) + '.lock.') && f.endsWith('.tmp'));
            expect(leftovers, 'the staging file must not be left behind').to.deep.equal([]);
        } finally {
            store.release();
            try { fs.unlinkSync(stateFile); } catch (e) { /* ignore */ }
        }
    });

    it('takes over a lock whose holder is dead, so a crash is not operator-only recovery', function () {
        const stateFile = tmpStateFile('lock-stale');
        // pid 2^22 is above the default pid_max on Linux and macOS, so it is
        // reliably not a live process.
        fs.writeFileSync(stateFile + '.lock', JSON.stringify({ pid: 4194304, t: Date.now() }));
        const store = new WindowStore(stateFile, 24, null, { init: true });
        try {
            expect(store.snapshot().count).to.equal(0);
        } finally {
            store.release();
            try { fs.unlinkSync(stateFile); } catch (e) { /* ignore */ }
        }
    });
});

describe('G5: window-store single-writer lock', function () {

    // The reclamation race. A stale takeover that deletes the lock BY NAME lets two
    // starters that both observed the same dead holder both delete: the second
    // one's unlink removes the first one's LIVE lock and it publishes its own.
    // Both stores then hold the file and, since each rewrites it whole from its own
    // cache, they discard each other's consumption history and restore the budget.
    //
    // Driven deterministically rather than with real concurrency: the second
    // starter's FIRST read of the lockfile is served the stale record it would
    // read before the first starter publishes, and everything after that is the
    // real code path.
    it('refuses a second starter that already read the stale holder the first one took over', function () {
        const stateFile = tmpStateFile('lock-race');
        const lockFile  = stateFile + '.lock';
        const staleRecord = JSON.stringify({ pid: 4194304, t: Date.now() });
        fs.writeFileSync(lockFile, staleRecord);

        const first = new WindowStore(stateFile, 24, null, { init: true });
        const published = fs.readFileSync(lockFile, 'utf8');

        const realRead = fs.readFileSync;
        let served = false;
        fs.readFileSync = function (p, ...rest) {
            if (!served && p === lockFile) { served = true; return staleRecord; }
            return realRead.call(fs, p, ...rest);
        };
        let err = null;
        try { new WindowStore(stateFile, 24, null, { init: true }); }
        catch (e) { err = e; }
        finally { fs.readFileSync = realRead; }

        try {
            expect(err, 'the second starter must not acquire a lock the first one holds').to.not.equal(null);
            expect(err.code).to.equal('WINDOW_STORE_LOCKED');
            expect(fs.existsSync(lockFile), 'the live lock must survive the refusal').to.equal(true);
            expect(fs.readFileSync(lockFile, 'utf8'), 'the surviving lock must still be the first store\'s')
                .to.equal(published);
            const leftovers = fs.readdirSync(path.dirname(stateFile))
                .filter(f => f.startsWith(path.basename(lockFile) + '.stale.'));
            expect(leftovers, 'a refused reclaim must not leave a carried-away lock behind').to.deep.equal([]);

            // And the survivor still owns the window: its charge persists.
            first.record({ action: 'SEND', tick: 'TOK', amount: '7' });
            expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).entries.length).to.equal(1);
        } finally {
            first.release();
            try { fs.unlinkSync(stateFile); } catch (e) { /* ignore */ }
        }
    });
});

describe('G5: window-store single-writer lock', function () {

    it('leaves no carried-away lock behind after a successful stale takeover', function () {
        const stateFile = tmpStateFile('lock-stale-clean');
        fs.writeFileSync(stateFile + '.lock', JSON.stringify({ pid: 4194304, t: Date.now() }));
        const store = new WindowStore(stateFile, 24, null, { init: true });
        try {
            const leftovers = fs.readdirSync(path.dirname(stateFile))
                .filter(f => f.startsWith(path.basename(stateFile) + '.lock.stale.'));
            expect(leftovers).to.deep.equal([]);
        } finally {
            store.release();
            try { fs.unlinkSync(stateFile); } catch (e) { /* ignore */ }
        }
    });

    // Fencing: the acquire fix stops two STARTERS racing, and this stops a store
    // that lost its lock afterwards from rewriting the window from a stale cache.
    it('refuses to record once its lock has been taken by another store', function () {
        const stateFile = tmpStateFile('lock-fence');
        const lockFile  = stateFile + '.lock';
        const first = new WindowStore(stateFile, 24, null, { init: true });
        first.record({ action: 'SEND', tick: 'TOK', amount: '5' });

        // An operator `rm` of the lockfile is enough; a successor then starts.
        fs.unlinkSync(lockFile);
        const second = new WindowStore(stateFile, 24, null, {});
        second.record({ action: 'SEND', tick: 'TOK', amount: '3' });
        const afterSecond = fs.readFileSync(stateFile, 'utf8');

        try {
            let err = null;
            try { first.record({ action: 'SEND', tick: 'TOK', amount: '99' }); } catch (e) { err = e; }
            expect(err, 'a fenced store must refuse rather than clobber').to.not.equal(null);
            expect(err.code).to.equal('WINDOW_STORE_FENCED');
            expect(fs.readFileSync(stateFile, 'utf8'), 'the successor\'s history must be untouched')
                .to.equal(afterSecond);
        } finally {
            second.release();
            try { fs.unlinkSync(stateFile); } catch (e) { /* ignore */ }
        }
    });
});

describe('G5: window-store single-writer lock', function () {

    it('does not delete a lock that now belongs to a successor', function () {
        const stateFile = tmpStateFile('lock-release-fence');
        const lockFile  = stateFile + '.lock';
        const first = new WindowStore(stateFile, 24, null, { init: true });
        fs.unlinkSync(lockFile);
        const second = new WindowStore(stateFile, 24, null, {});
        const successorLock = fs.readFileSync(lockFile, 'utf8');
        try {
            first.release();
            expect(fs.existsSync(lockFile), 'the successor\'s lock must survive').to.equal(true);
            expect(fs.readFileSync(lockFile, 'utf8')).to.equal(successorLock);
        } finally {
            second.release();
            try { fs.unlinkSync(stateFile); } catch (e) { /* ignore */ }
        }
    });
});
