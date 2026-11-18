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
 * XChain Platform SDK - keyed contract reads
 *
 * Reads one contract state key or balance tick through the explorer's
 * contract routes.
 *
 ********************************************************************/

const { SDKExplorerError } = require('../../utils/errors.js');

// The explorer's per-page ceiling for these routes, and how many pages one keyed
// read walks before it gives up rather than hammering a very large contract.
const SCAN_PAGE_LIMIT = 100;
const SCAN_PAGE_CAP = 10;

// Requests a keyed read spent, by reply object, so a polling caller can pace itself
// against the explorer's per-address request limit.
const spent = new WeakMap();

function readCost(reply) {
    return reply && typeof reply === 'object' && spent.has(reply) ? spent.get(reply) : 1;
}

function rowsOf(reply) {
    return reply && Array.isArray(reply.data) ? reply.data : [];
}

function holdsRow(reply, field, wanted) {
    return rowsOf(reply).some(row => row && String(row[field]) === wanted);
}

// A route that does not narrow by the trailing segment answers page one of the whole
// sorted set, so the wanted row can sit on a later page. Return the reply that holds
// the row. A row that is absent from a complete listing returns the first reply
// untouched, as a narrowing explorer would answer a missing row. A listing too big to
// walk throws instead of answering as though the row were absent.
async function readKeyedRow(client, path, field, wanted) {
    const target = String(wanted);
    const first = await client.get(path);
    const total = Number(first && first.total);
    if (holdsRow(first, field, target) || !(total > rowsOf(first).length)) return first;
    let requests = 1;
    const answer = (reply, own) => {
        if (reply && typeof reply === 'object') spent.set(reply, requests);
        return own;
    };

    // The default page is the route's own ceiling, so a full first reply is page one already.
    const startPage = rowsOf(first).length === SCAN_PAGE_LIMIT ? 2 : 1;
    for (let page = startPage; page <= SCAN_PAGE_CAP; page++) {
        const reply = await client.get(path, { page, limit: SCAN_PAGE_LIMIT });
        requests++;
        if (holdsRow(reply, field, target)) return answer(reply, reply);
        if (rowsOf(reply).length === 0 || page * SCAN_PAGE_LIMIT >= Number(reply.total)) return answer(first, first);
    }
    throw new SDKExplorerError('CONTRACT_READ_TRUNCATED',
        'The explorer lists ' + total + ' rows for ' + path + ' and returns them a page at a time; ' +
        target + ' is not in the first ' + (SCAN_PAGE_CAP * SCAN_PAGE_LIMIT) + '.',
        { path, wanted: target, total, scanned: SCAN_PAGE_CAP * SCAN_PAGE_LIMIT, requests });
}

module.exports = { readKeyedRow, readCost, SCAN_PAGE_LIMIT, SCAN_PAGE_CAP };
