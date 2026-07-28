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

const fs   = require('fs');
const path = require('path');
const { addDecimal, UNRESOLVED_TICK_BUCKET } = require('./policyEvaluator.js');

// How far ahead of our own clock a persisted timestamp may sit before it is
// treated as a clock fault rather than ordinary jitter (G19). Generous enough to
// absorb NTP slew and a coarse filesystem clock, far tighter than any window.
const CLOCK_SKEW_TOLERANCE_MS = 60 * 1000;

// Lock files this process currently holds, released on exit so a clean shutdown
// (or an uncaught throw) never leaves a stale lock that an operator has to clear
// by hand before the daemon will start again.
const HELD_LOCKS = new Set();
let exitHookInstalled = false;

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

    // Exclusive advisory lock: an O_EXCL lockfile carrying the holder's pid.
    // O_EXCL create is atomic, so two processes racing to start cannot both win.
    // A lockfile whose recorded pid is no longer alive is a crash leftover and
    // is taken over (with a loud note), because refusing to start after a crash
    // would turn a liveness blip into an operator-only recovery.
    _acquireLock() {
        const lockFile = this._stateFile + '.lock';
        fs.mkdirSync(path.dirname(this._stateFile), { recursive: true });
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const fd = fs.openSync(lockFile, 'wx', 0o600);
                fs.writeSync(fd, JSON.stringify({ pid: process.pid, t: Date.now() }));
                fs.closeSync(fd);
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
                // Stale: the recorded holder is gone (or the lock is unreadable).
                console.warn(`[cosigner] taking over a stale window-store lock at ${lockFile}` +
                    (pid ? ` (dead pid ${pid})` : ' (unreadable holder record)'));
                try { fs.unlinkSync(lockFile); } catch (e2) { /* raced; the retry re-checks */ }
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
        try { fs.unlinkSync(this._lockFile); } catch (e) { /* already gone */ }
        HELD_LOCKS.delete(this._lockFile);
        this._lockFile = null;
    }

    _fault(message, context) {
        if (this._onFault) {
            try { this._onFault(message, context); return; } catch (e) { /* observer must never break enforcement */ }
        }
        console.error(`[cosigner] ${message}`, context || '');
    }

    _load() {
        if (this._usage) return this._usage;
        // G6: an ABSENT state file is a hard error, not an empty window. The old
        // behaviour made `rm window.json` exactly the budget reset this document
        // elsewhere calls impossible - no corruption, no warning, full budget back.
        // Creating a window is now an explicit operator act (init: true, or
        // `npm run cosigner:init-window`), so deletion fails loudly instead.
        if (!fs.existsSync(this._stateFile)) {
            if (!this._init) {
                const err = new Error(`co-signer window state at ${this._stateFile} does not exist. ` +
                    `An absent window is NOT an empty one: treating it as empty would restore the full ` +
                    `spending budget, which is what deleting the file would otherwise achieve. If this ` +
                    `is a new deployment, create it deliberately (new WindowStore(path, hours, null, ` +
                    `{ init: true }) or npm run cosigner:init-window); if it is not, restore the file.`);
                err.code = 'WINDOW_STATE_MISSING';
                throw err;
            }
            this._usage = { entries: [], lastSeen: this._now() };
            this._persist(this._usage);
            return this._usage;
        }
        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(this._stateFile, 'utf8'));
            if (!Array.isArray(parsed.entries)) throw new Error('entries missing');
        } catch (e) {
            // Fail CLOSED: never silently reset a corrupt window (that re-opens the budget).
            const err = new Error(`co-signer window state at ${this._stateFile} is unreadable ` +
                `(${e.message}); inspect/remove it deliberately to reset the spending window`);
            err.code = 'WINDOW_STATE_CORRUPT';
            throw err;
        }
        this._applyClockGuards(parsed);
        this._usage = parsed;
        return this._usage;
    }

    // G19: the rolling window is wall-clock based, so the clock is part of the
    // trust boundary. A FORWARD step (NTP correction, VM resume from snapshot,
    // container skew, or a co-located agent with time privileges) ages entries out
    // early and silently re-opens budget; a BACKWARD step is harmless for the
    // budget but signals the same lost control. Neither can be prevented from in
    // here - the operator has to own the host clock - but both can be made loud,
    // and a future-dated entry can be refused outright.
    _applyClockGuards(parsed) {
        const now = this._now();
        if (Number.isFinite(parsed.lastSeen) && parsed.lastSeen > now + CLOCK_SKEW_TOLERANCE_MS)
            this._fault('the host clock moved BACKWARD across a restart: the window was last written ' +
                `${Math.round((parsed.lastSeen - now) / 1000)}s in the future. Entries are retained, so the ` +
                'budget is not re-opened, but a clock the daemon does not control can also step FORWARD, ' +
                'which ages entries out early and does re-open it. The host clock must be operator-' +
                'controlled and never settable by the agent uid.', { lastSeen: parsed.lastSeen, now });
        let clamped = 0;
        for (const e of parsed.entries) {
            if (Number.isFinite(e.t) && e.t > now + CLOCK_SKEW_TOLERANCE_MS) {
                // Refuse the future timestamp, keep the entry. Dropping it would
                // LOOSEN the budget, which is the wrong direction to fail in;
                // clamping to now keeps it counted for a full window.
                e.t = now;
                clamped++;
            }
        }
        if (clamped)
            this._fault(`${clamped} window entr${clamped === 1 ? 'y was' : 'ies were'} timestamped in the ` +
                'future and had their timestamps clamped to now. A future-dated entry cannot be produced by ' +
                'this daemon under a sane clock.', { clamped });
    }

    _pruned() {
        const usage = this._load();
        const cutoff = this._now() - this._hours * 3600 * 1000;
        usage.entries = usage.entries.filter((e) => e.t >= cutoff);
        return usage;
    }

    // Current window snapshot in the shape policyEvaluator expects.
    //
    // perTick is NULL-PROTOTYPE (G1). Ticks are decoded from the agent's own
    // OP_RETURN, so they are attacker-chosen strings used directly as keys here.
    // On a plain `{}` a tick of `constructor` / `toString` / `valueOf` resolves
    // to an inherited function, and `addDecimal(fn, amount)` throws - permanently,
    // on every subsequent request, because the entry is already persisted. That
    // is a remote freeze of the account, which on a plain 2-of-2 means funds
    // stuck for good. With a null prototype no decoded string can resolve to
    // anything but a value this store itself put there.
    //
    // The accumulate is ALSO wrapped: an entry that cannot be added (a legacy
    // poisoned row written before this fix, or any future shape surprise) is
    // quarantined and reported, never allowed to throw the whole daemon down.
    // It still counts toward `count`, so quarantining can only ever tighten the
    // budget, never loosen it.
    snapshot() {
        const usage = this._pruned();
        const perTick = Object.create(null);
        for (const e of usage.entries) {
            if (e.amount === undefined) continue;
            try {
                // G8: an entry whose tick never resolved still accumulates, under a
                // reserved bucket the evaluator reads for exactly that case. Skipping
                // these (the old behaviour) made every wildcard window cap read a used
                // total of '0' for them forever, so the cap bound each transaction
                // independently instead of the window.
                const key = e.tick === undefined || e.tick === null
                    ? UNRESOLVED_TICK_BUCKET : String(e.tick);
                perTick[key] = addDecimal(perTick[key] || '0', e.amount);
            } catch (err) {
                this._quarantined.push(e);
                this._fault(`window entry quarantined (tick=${String(e.tick).slice(0, 32)}): ${err.message}`,
                    { action: e.action, txid: e.txid || null });
            }
        }
        return { count: usage.entries.length, perTick };
    }

    // Entries this store could not accumulate. Non-empty means the persisted
    // window is under-counting amounts (never over-counting) and wants an
    // operator look.
    quarantined() { return this._quarantined.slice(); }

    // Append a consumed action. Call AFTER deciding to authorize (partial-sign):
    // the budget is consumed on authorization, conservatively, even if the agent
    // never completes the aggregate (can't double-spend the cap).
    record({ action, tick, amount, txid }) {
        const usage = this._pruned();
        const now = this._now();
        // G19: a backward clock step between writes would let a later entry sort
        // before an earlier one and age out first. Say so; the operator owns the
        // host clock, and this is the only place the daemon can see it move.
        const newest = usage.entries.reduce((m, e) => (Number.isFinite(e.t) && e.t > m ? e.t : m), -Infinity);
        if (Number.isFinite(newest) && now + CLOCK_SKEW_TOLERANCE_MS < newest)
            this._fault('the host clock moved BACKWARD while the daemon was running ' +
                `(${Math.round((newest - now) / 1000)}s); the rolling window trusts wall-clock time`,
                { newest, now });
        usage.entries.push({ t: now, action, tick, amount, txid });
        usage.lastSeen = Math.max(now, Number.isFinite(usage.lastSeen) ? usage.lastSeen : now);
        this._persist(usage);
        this._usage = usage;
    }

    // Atomic, DURABLE write: tmp + fsync + rename + fsync(dir).
    //
    // G6: without the fsyncs the rename is atomic only with respect to other
    // readers, not to a host crash. The tmp file's CONTENTS and the directory
    // entry can both still be in the page cache when power is lost, so the store
    // rolls back to an earlier state and silently returns already-spent budget -
    // the same re-opening as a deleted file, just rarer and harder to notice.
    // The file is 0600: the window is both the spending budget and the approval
    // audit log, and nothing but the daemon uid has any business in it.
    _persist(usage) {
        fs.mkdirSync(path.dirname(this._stateFile), { recursive: true });
        const tmp = this._stateFile + '.tmp';
        const fd = fs.openSync(tmp, 'w', 0o600);
        try {
            fs.writeSync(fd, JSON.stringify(usage));
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        fs.renameSync(tmp, this._stateFile);
        // fsync the DIRECTORY too, or the rename itself can be lost. Not portable
        // everywhere (Windows rejects opening a directory), so failure here is
        // reported, not fatal: the data fsync above is the load-bearing half.
        try {
            const dfd = fs.openSync(path.dirname(this._stateFile), 'r');
            try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
        } catch (e) {
            this._fault(`could not fsync the window-store directory (${e.message}); a host crash could ` +
                'still lose the most recent charge', { stateFile: this._stateFile });
        }
    }
}

module.exports = WindowStore;
