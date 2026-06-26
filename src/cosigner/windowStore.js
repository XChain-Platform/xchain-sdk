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
 ********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { addDecimal } = require('./policyEvaluator.js');

class WindowStore {

    // @param {string} stateFile   absolute path to the JSON usage file
    // @param {number} hours       window length; entries older than this are pruned
    // @param {function} [now]     injectable clock (ms) for tests; defaults to Date.now
    constructor(stateFile, hours, now) {
        if (!stateFile) throw new Error('WindowStore requires a stateFile path');
        if (!Number.isFinite(hours) || hours <= 0) throw new Error('WindowStore requires positive hours');
        this._stateFile = stateFile;
        this._hours = hours;
        this._now = now || Date.now;
        this._usage = null;
    }

    _load() {
        if (this._usage) return this._usage;
        try {
            if (fs.existsSync(this._stateFile)) {
                const parsed = JSON.parse(fs.readFileSync(this._stateFile, 'utf8'));
                if (!Array.isArray(parsed.entries)) throw new Error('entries missing');
                this._usage = parsed;
            } else {
                this._usage = { entries: [] };
            }
        } catch (e) {
            // Fail CLOSED: never silently reset a corrupt window (that re-opens the budget).
            const err = new Error(`co-signer window state at ${this._stateFile} is unreadable ` +
                `(${e.message}); inspect/remove it deliberately to reset the spending window`);
            err.code = 'WINDOW_STATE_CORRUPT';
            throw err;
        }
        return this._usage;
    }

    _pruned() {
        const usage = this._load();
        const cutoff = this._now() - this._hours * 3600 * 1000;
        usage.entries = usage.entries.filter((e) => e.t >= cutoff);
        return usage;
    }

    // Current window snapshot in the shape policyEvaluator expects.
    snapshot() {
        const usage = this._pruned();
        const perTick = {};
        for (const e of usage.entries)
            if (e.tick !== undefined && e.amount !== undefined)
                perTick[e.tick] = addDecimal(perTick[e.tick] || '0', e.amount);
        return { count: usage.entries.length, perTick };
    }

    // Append a consumed action. Call AFTER deciding to authorize (partial-sign):
    // the budget is consumed on authorization, conservatively, even if the agent
    // never completes the aggregate (can't double-spend the cap).
    record({ action, tick, amount, txid }) {
        const usage = this._pruned();
        usage.entries.push({ t: this._now(), action, tick, amount, txid });
        fs.mkdirSync(path.dirname(this._stateFile), { recursive: true });
        const tmp = this._stateFile + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(usage));
        fs.renameSync(tmp, this._stateFile);
        this._usage = usage;
    }
}

module.exports = WindowStore;
