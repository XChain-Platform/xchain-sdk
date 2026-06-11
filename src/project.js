/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Platform SDK - Project Registry Helpers
 *
 * A project registry is a composition of existing primitives, not a
 * new action (see xchain-documentation/protocol/Project_Registry.md):
 * the project is a TICK, its official-token roster is a TICK-type
 * LIST, and the binding is a LINK from the LIST to the project's
 * ISSUE — which the indexer only accepts from the project tick's
 * current owner. These helpers build the params in one place so every
 * client publishes rosters correctly. All pure — no network, no
 * consensus. Submit-flow recipes live on sdk.workflows (setRoster).
 *
 ********************************************************************/

class ProjectHelpers {

    // Build LIST params for a new official-token roster (LIST v0, TYPE=TICK).
    //
    // ticks - array of TICK names to include
    rosterParams({ ticks } = {}) {
        let items = this._tickArray(ticks, 'project.rosterParams');
        return { type: '1', item: items };
    }

    // Build LIST params that derive a new roster from an existing one
    // (LIST v1). EDIT is a single operation per action — pass `add` OR
    // `remove`, not both (two edits = two LIST actions).
    //
    // listActionIndex - ACTION_INDEX of the roster being edited
    // add             - array of TICK names to add
    // remove          - array of TICK names to remove
    rosterEditParams({ listActionIndex, add, remove } = {}) {
        if (listActionIndex === undefined || listActionIndex === null)
            throw new Error('project.rosterEditParams: listActionIndex is required');
        if (add && remove)
            throw new Error('project.rosterEditParams: pass add OR remove, not both (one EDIT per LIST action)');
        if (!add && !remove)
            throw new Error('project.rosterEditParams: add or remove is required');
        let items = this._tickArray(add || remove, 'project.rosterEditParams');
        return {
            edit:            add ? '1' : '2',
            listActionIndex: String(listActionIndex),
            item:            items
        };
    }

    // Build LINK params attesting a roster to the project (the green-banner
    // attestation). The LINK SOURCE must be the project tick's current owner;
    // the indexer validates ownership and rejects during ownership escrow.
    // Both sides MUST be on the project's own chain — LINK skips owner
    // validation when COIN2 is remote, so cross-chain roster links carry no
    // authority (Project_Registry.md).
    //
    // coin             - the project's chain (BTC/LTC/DOGE)
    // listActionIndex  - ACTION_INDEX of the roster LIST
    // issueActionIndex - ACTION_INDEX of the project tick's ISSUE
    attestRosterParams({ coin, listActionIndex, issueActionIndex, memo } = {}) {
        if (!coin)
            throw new Error('project.attestRosterParams: coin is required');
        if (listActionIndex === undefined || listActionIndex === null || issueActionIndex === undefined || issueActionIndex === null)
            throw new Error('project.attestRosterParams: listActionIndex and issueActionIndex are required');
        return {
            coin1:            coin,
            coin1ActionIndex: String(listActionIndex),
            coin2:            coin,
            coin2ActionIndex: String(issueActionIndex),
            memo
        };
    }

    // Normalize + validate a tick array
    _tickArray(ticks, context) {
        if (ticks !== undefined && ticks !== null && !Array.isArray(ticks))
            ticks = [ticks];
        if (!Array.isArray(ticks) || ticks.length === 0)
            throw new Error(context + ': ticks is required (non-empty array of TICK names)');
        return ticks.map(t => {
            let tick = String(t).trim();
            if (!tick) throw new Error(context + ': empty TICK name');
            return tick;
        });
    }
}

module.exports = ProjectHelpers;
