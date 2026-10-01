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

async function mapWithLimit(items, limit, fn) {
    if (!Array.isArray(items)) throw new TypeError('items must be an array');
    if (!Number.isInteger(limit) || limit < 1)
        throw new RangeError('limit must be a positive integer');
    if (typeof fn !== 'function') throw new TypeError('fn must be a function');

    const results = new Array(items.length);
    let nextIndex = 0;
    let failed = false;

    async function worker() {
        while (!failed) {
            const index = nextIndex;
            if (index >= items.length) return;
            nextIndex += 1;

            try {
                results[index] = await fn(items[index], index);
            } catch (error) {
                if (!failed) {
                    failed = true;
                    throw error;
                }
                return;
            }
        }
    }

    const workerCount = Math.min(limit, items.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
}

module.exports = { mapWithLimit };
