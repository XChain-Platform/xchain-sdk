// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

function actionRecord(raw) {
    if (!raw) return null;
    let record = raw.data !== undefined ? raw.data : raw;
    if (Array.isArray(record)) record = record[0] || null;
    return record && typeof record === 'object' ? record : null;
}

async function readParentListType(explorer, listActionIndex, cap) {
    if (!explorer || typeof explorer.getAction !== 'function'
        || listActionIndex === undefined || listActionIndex === null) return null;
    try {
        let raw = await cap(Promise.resolve().then(() => explorer.getAction(listActionIndex)));
        let record = actionRecord(raw);
        return record ? (record.type ?? record.TYPE ?? null) : null;
    } catch (e) {
        return null;
    }
}

module.exports = { actionRecord, readParentListType };
