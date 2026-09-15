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
 * XChain Platform SDK - Co-Signer Window Store
 *
 * Server-side spending-window usage for the MuSig2 co-signer daemon. The
 * client-side AgentSession window can be reset by whoever holds the WIF,
 * so for HARD enforcement the daemon owns its own copy here.
 *
 * Fail-closed, mirroring AgentSession's file-backed window: a corrupt or
 * unreadable state file THROWS rather than silently resetting the window
 * (a silent reset would re-open the whole budget). Atomic write via
 * tmp + rename so a crash mid-write can't truncate the store.
 *
 * SINGLE WRITER IS A SAFETY PROPERTY, NOT AN HA NICETY (G5). This store
 * caches its entry array in memory on first load and never re-reads it, then
 * rewrites the WHOLE file from that cache. Two daemons sharing one store
 * therefore do not merely race a counter: they alternately discard each
 * other's entire consumption history, which re-opens the full budget with no
 * symptom at all. `pm2` cluster mode, a systemd unit started twice, or a
 * forgotten sidecar from an earlier shell is enough to do it. So the store
 * takes an exclusive advisory lock at construction and REFUSES to start while
 * another live process holds it.
 *
 ********************************************************************/

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { getLogger } = require('../observability/logger.js');
const log = getLogger('xchain-sdk:cosigner');

// Lock files this process currently holds, released on exit so a clean shutdown
// (or an uncaught throw) never leaves a stale lock that an operator has to clear
// by hand before the daemon will start again.
const HELD_LOCKS = new Set();
let exitHookInstalled = false;

// link() errno values that mean "this mount cannot hardlink", as opposed to
// "the name is taken" (EEXIST). Only these fall back to create-then-write.
const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOSYS', 'EOPNOTSUPP', 'ENOTSUP', 'EXDEV', 'EMLINK']);

function installExitHook() {
    if (exitHookInstalled) return;
    exitHookInstalled = true;
    process.on('exit', () => {
        for (const lockFile of HELD_LOCKS) {
            try { fs.unlinkSync(lockFile); } catch (e) { /* best effort on the way out */ }
        }
    });
}

// Is a pid still running? `kill(pid, 0)` sends no signal and only probes.
// EPERM means the process exists but belongs to another user, which still
// counts as alive - taking its lock over would be exactly the double-writer
// this guards against.
function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; }
    catch (e) { return e.code === 'EPERM'; }
}

function reclaimStaleLock(lockFile, pid) {
    // Stale: the recorded holder is provably gone. Reclaim by RENAME,
    // never by name.
    //
    // unlinkSync(lockFile) deletes whatever sits at that name when it
    // runs, which need not be the record just read. Two starters that
    // both observe the same dead holder both reach this line: the first
    // deletes the stale lock and publishes a LIVE one, and the second's
    // unlink then deletes that live lock and publishes its own. Both
    // constructors return, both stores hold the file, and because each
    // rewrites the whole file from its own cache they discard each
    // other's consumption history and silently restore the full
    // spending budget. _publishLock's hardlink atomicity covers
    // publication, not reclamation, so it never saw this.
    //
    // rename claims one directory entry atomically, so only one
    // contender can carry the file away, and the carried record is then
    // checked against the dead holder that authorized the takeover.
    log.warn(`[cosigner] taking over a stale window-store lock at ${lockFile} (dead pid ${pid})`);
    const carried = `${lockFile}.stale.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
    try { fs.renameSync(lockFile, carried); }
    catch (e2) { return; }   // another starter carried it away; the retry re-reads
    let carriedHolder = null;
    try { carriedHolder = JSON.parse(fs.readFileSync(carried, 'utf8')); } catch (e2) { /* unreadable */ }
    const carriedPid = carriedHolder && carriedHolder.pid;
    if (carriedPid !== pid || pidAlive(carriedPid)) {
        // Not the record that authorized this takeover: a successor
        // published between the read and the rename. Put it back and
        // refuse, rather than deleting a lock somebody else is holding.
        let restored = false;
        try { fs.linkSync(carried, lockFile); restored = true; }
        catch (e2) {
            if (e2.code !== 'EEXIST' && !fs.existsSync(lockFile)) {
                try { fs.renameSync(carried, lockFile); restored = true; }
                catch (e3) { /* leave the carried file for the operator to find */ }
            }
        }
        if (restored || fs.existsSync(lockFile))
            try { fs.unlinkSync(carried); } catch (e2) { /* already moved or gone */ }
        const err = new Error(
            `co-signer window state at ${this._stateFile}: the stale lock at ${lockFile} was ` +
            `reclaimed by another starting process before this one could take it over. Two ` +
            `daemons sharing one window store overwrite each other's consumption history ` +
            `wholesale, silently re-opening the full spending budget; refusing to start.`);
        err.code = 'WINDOW_STORE_LOCKED';
        err.holderPid = Number.isInteger(carriedPid) ? carriedPid : null;
        throw err;
    }
    try { fs.unlinkSync(carried); } catch (e2) { /* already gone */ }
}

class WindowStore {

    // @param {string} stateFile   absolute path to the JSON usage file
    // @param {number} hours       window length; entries older than this are pruned
    // @param {function} [now]     injectable clock (ms) for tests; defaults to Date.now
    // @param {object} [opts]
    //   lock    {boolean}  default true; take the exclusive single-writer lock
    //   init    {boolean}  default false; CREATE a fresh empty window. Required
    //                      when the state file does not exist (G6): an absent
    //                      file is otherwise a hard startup error, never an
    //                      implicit fresh budget.
    //   onFault {function} called with (message, context) for a quarantined entry
    constructor(stateFile, hours, now, opts = {}) {
        if (!stateFile) throw new Error('WindowStore requires a stateFile path');
        if (!Number.isFinite(hours) || hours <= 0) throw new Error('WindowStore requires positive hours');
        this._stateFile = stateFile;
        this._hours = hours;
        this._now = now || Date.now;
        this._usage = null;
        this._onFault = typeof opts.onFault === 'function' ? opts.onFault : null;
        // Entries that could not be accumulated (see snapshot). Held so an
        // operator can be told about them without the store throwing forever.
        this._quarantined = [];
        this._lockFile = null;
        // Identifies THIS store instance in the holder record, so a store that has
        // lost its lock can tell the difference between "the lock is still mine"
        // and "a lockfile exists". The pid alone cannot: a successor on the same
        // host, or this pid after an operator cleared and another daemon retook the
        // file, both read back as a plausible holder.
        this._lockNonce = crypto.randomBytes(16).toString('hex');
        this._init = opts.init === true;
        if (opts.lock !== false) this._acquireLock();
        // Load EAGERLY so an absent or unreadable window is a startup failure the
        // operator sees at boot, not a surprise on the first co-sign request.
        try {
            this._load();
        } catch (e) {
            this.release();
            throw e;
        }
    }

    // Publish the holder record and the lockfile NAME in one atomic step: build a
    // complete `<lock>.<pid>.tmp` first, then hardlink it into place. link() either
    // creates the name or fails EEXIST, and it can only ever create a name that
    // already has the full record behind it.
    //
    // Create-then-write did NOT have that property, and the gap was the whole bug:
    // between openSync(lockFile,'wx') and the writeSync that filled it, the lockfile
    // existed and was EMPTY. A second daemon starting in that window read zero bytes,
    // failed to parse a holder, could not prove any pid alive, and reclaimed the live
    // lock as stale. Both processes then held the store, and because each caches the
    // whole entry array and rewrites the file from that cache, they discard each
    // other's consumption history and silently re-open the full budget.
    //
    // Falls back to the old create-then-write on mounts with no hardlink support
    // (some network and FUSE filesystems), where the empty-file window returns and
    // the fail-closed unreadable-holder branch in _acquireLock is what covers it.
    _publishLock(lockFile) {
        const tmp    = `${lockFile}.${process.pid}.tmp`;
        // `pid` and `t` keep their exact shape: external tooling reads them. The
        // nonce is additive, and is what assertLockOwned compares against.
        const record = JSON.stringify({ pid: process.pid, t: Date.now(), nonce: this._lockNonce });
        let fd = null;
        try {
            fd = fs.openSync(tmp, 'w', 0o600);
            fs.writeSync(fd, record);
            // Durability only: a lock name whose content never reached disk comes
            // back from a power loss as the empty file this whole method exists to
            // rule out. Not the safety property, so a filesystem that refuses is fine.
            try { fs.fsyncSync(fd); } catch (e) { /* best effort */ }
            fs.closeSync(fd);
            fd = null;
            fs.linkSync(tmp, lockFile);
        } catch (e) {
            if (e.code === 'EEXIST' || !LINK_UNSUPPORTED.has(e.code)) throw e;
            const fallbackFd = fs.openSync(lockFile, 'wx', 0o600);
            try { fs.writeSync(fallbackFd, record); } finally { fs.closeSync(fallbackFd); }
        } finally {
            if (fd !== null) { try { fs.closeSync(fd); } catch (e2) { /* already gone */ } }
            try { fs.unlinkSync(tmp); } catch (e2) { /* never created, or already reaped */ }
        }
    }

    // Exclusive advisory lock: a lockfile carrying the holder's pid, published
    // atomically by _publishLock so it is never observable empty or half-written.
    // A lockfile whose recorded pid is PROVABLY not alive is a crash leftover and
    // is taken over (with a loud note), because refusing to start after a crash
    // would turn a liveness blip into an operator-only recovery.
    //
    // An unreadable holder record is NOT that proof and never authorizes reclaiming
    // the lock: "I cannot tell who holds this" and "nobody holds this" are different
    // answers, and only the second one makes taking it over safe. Fail closed and
    // make the operator look, because the failure this guards is silent budget reset.
    _acquireLock() {
        const lockFile = this._stateFile + '.lock';
        fs.mkdirSync(path.dirname(this._stateFile), { recursive: true });
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                this._publishLock(lockFile);
                this._lockFile = lockFile;
                HELD_LOCKS.add(lockFile);
                installExitHook();
                return;
            } catch (e) {
                if (e.code !== 'EEXIST') throw e;
                let holder = null;
                try { holder = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch (e2) { /* unreadable lock */ }
                const pid = holder && holder.pid;
                if (pidAlive(pid)) {
                    const err = new Error(
                        `co-signer window state at ${this._stateFile} is locked by a live process (pid ${pid}). ` +
                        `Two daemons sharing one window store overwrite each other's consumption history ` +
                        `wholesale, silently re-opening the full spending budget; refusing to start. ` +
                        `Stop the other daemon, or point this one at its own stateFile.`);
                    err.code = 'WINDOW_STORE_LOCKED';
                    err.holderPid = pid ?? null;
                    throw err;
                }
                if (!Number.isInteger(pid) || pid <= 0) {
                    const err = new Error(
                        `co-signer window state at ${this._stateFile} is locked by ${lockFile}, whose holder ` +
                        `record does not name a process. That is not evidence the lock is stale, and taking it ` +
                        `over on a guess is how two daemons end up sharing one window store and silently ` +
                        `re-opening the full spending budget; refusing to start. Confirm no co-signer daemon ` +
                        `is running against this state file, then delete ${lockFile}.`);
                    err.code = 'WINDOW_STORE_LOCKED';
                    err.holderPid = null;
                    throw err;
                }
                reclaimStaleLock.call(this, lockFile, pid);
            }
        }
        const err = new Error(`co-signer window state at ${this._stateFile}: could not acquire the ` +
            `single-writer lock (contended by another starting process)`);
        err.code = 'WINDOW_STORE_LOCKED';
        throw err;
    }

    // Release the single-writer lock. Call when deliberately handing the store
    // over (or at shutdown); the process-exit hook is the backstop.
    release() {
        if (!this._lockFile) return;
        // Only ever remove a lock this instance still owns. A lockfile at our name
        // that carries somebody else's nonce belongs to a successor, and deleting
        // it would hand the store to a third starter as a free takeover.
        if (this.lockIsOurs() !== false)
            try { fs.unlinkSync(this._lockFile); } catch (e) { /* already gone */ }
        HELD_LOCKS.delete(this._lockFile);
        this._lockFile = null;
    }

    // Tri-state on purpose: true (ours), false (provably somebody else's), null
    // (no readable holder record, so no proof either way). Only `false` is
    // evidence of loss, mirroring the acquire path's rule that "I cannot tell who
    // holds this" and "nobody holds this" are different answers.
    lockIsOurs() {
        let holder = null;
        try { holder = JSON.parse(fs.readFileSync(this._lockFile, 'utf8')); }
        catch (e) { return e.code === 'ENOENT' ? false : null; }
        if (!holder || typeof holder.nonce !== 'string') return null;
        return holder.nonce === this._lockNonce;
    }

    // Refuse to write the window from a cache this store no longer has the right
    // to publish. The acquire fix stops two STARTERS racing; this stops a store
    // that lost its lock afterwards (an operator `rm` of the lockfile, a rogue
    // non-protocol writer, a container restart reusing the path) from rewriting
    // the whole file and restoring already-spent budget. Fail closed and loud: the
    // co-signer treats a throw out of record() as a refusal to authorize, so no
    // signature is released by a fenced store.
    assertLockOwned() {
        if (!this._lockFile) return;   // constructed with { lock: false }
        if (this.lockIsOurs() !== false) return;
        const message = `co-signer window state at ${this._stateFile} is no longer owned by this store ` +
            `(the lock at ${this._lockFile} names another holder). Writing the window from this store's ` +
            `cache would discard another daemon's consumption history and re-open the spending budget; ` +
            `refusing. Confirm which daemon owns this state file.`;
        this._fault(message, { stateFile: this._stateFile, lockFile: this._lockFile });
        const err = new Error(message);
        err.code = 'WINDOW_STORE_FENCED';
        throw err;
    }

    _fault(message, context) {
        if (this._onFault) {
            try { this._onFault(message, context); return; } catch (e) { /* observer must never break enforcement */ }
        }
        log.error(`[cosigner] ${message}`, context || '');
    }

}

Object.assign(WindowStore.prototype, require('./window_store/window_ledger.js'));

module.exports = WindowStore;
