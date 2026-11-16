/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const { readRecentBlockTimes } = require('../../src/file/multipart_block_times.js');

function explorerReturning(body) {
    const calls = [];
    return {
        calls,
        get: async (path, params) => {
            calls.push({ path, params });
            return body;
        }
    };
}

describe('readRecentBlockTimes explorer request', function () {
    it('uses the default window once and sorts an envelope newest first', async function () {
        const explorer = explorerReturning({
            total: 2,
            data: [
                { block_index: 10, block_time: 1000 },
                { block_index: 11, block_time: '1100' }
            ]
        });
        const times = await readRecentBlockTimes(explorer);
        assert.deepStrictEqual(times, [1100, 1000]);
        assert.deepStrictEqual(explorer.calls, [
            { path: '/blocks', params: { limit: 11, sortorder: 'DESC' } }
        ]);
    });

    it('uses a custom window once with a bare array', async function () {
        const explorer = explorerReturning([
            { block_index: 0, block_time: 50 },
            { block_index: 1, block_time: 100 },
            { block_index: 2, block_time: 200 },
            { block_index: 3, block_time: 300 }
        ]);
        assert.deepStrictEqual(await readRecentBlockTimes(explorer, 3), [300, 200, 100]);
        assert.deepStrictEqual(explorer.calls, [
            { path: '/blocks', params: { limit: 3, sortorder: 'DESC' } }
        ]);
    });
});

describe('readRecentBlockTimes explorer row shape', function () {
    it('reads the explorer /blocks timestamp field', async function () {
        const explorer = explorerReturning({
            total: 2,
            data: [
                { block_index: '71178', timestamp: '1794803000' },
                { block_index: '71179', timestamp: '1794803062' }
            ]
        });
        assert.deepStrictEqual(await readRecentBlockTimes(explorer, 2), [1794803062, 1794803000]);
    });
});

describe('readRecentBlockTimes result filtering', function () {
    it('drops invalid times before trimming the ordered result', async function () {
        const explorer = explorerReturning([
            { block_index: 1, block_time: 100 },
            { block_index: 2, block_time: 200 },
            { block_index: 3, block_time: 0 },
            { block_index: 4, block_time: null },
            { block_index: 5, block_time: 500 },
            { block_index: 6, block_time: -1 },
            { block_index: 7, block_time: Infinity }
        ]);
        assert.deepStrictEqual(await readRecentBlockTimes(explorer, 3), [500, 200, 100]);
        assert.strictEqual(explorer.calls.length, 1);
    });

    it('returns an empty array for an empty body', async function () {
        const explorer = explorerReturning(undefined);
        assert.deepStrictEqual(await readRecentBlockTimes(explorer), []);
        assert.strictEqual(explorer.calls.length, 1);
    });
});

describe('readRecentBlockTimes argument validation', function () {
    it('rejects invalid counts before making a request', async function () {
        for (const count of [0, 101, 1.5, '3', NaN]) {
            const explorer = explorerReturning([]);
            await assert.rejects(() => readRecentBlockTimes(explorer, count), /count/);
            assert.deepStrictEqual(explorer.calls, []);
        }
    });

    it('rejects an explorer without get before making a request', async function () {
        const explorer = { calls: [], get: null };
        await assert.rejects(() => readRecentBlockTimes(explorer), /explorer/);
        assert.deepStrictEqual(explorer.calls, []);
    });
});
