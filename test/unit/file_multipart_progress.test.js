'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const {
    MULTIPART_PROGRESS_STEPS,
    makeProgressEmitter,
} = require('../../src/file/multipart_progress.js');

describe('multipart progress step list', function () {
    it('exports the frozen ordered step list', function () {
        assert.deepStrictEqual(MULTIPART_PROGRESS_STEPS, [
            'planned',
            'funding_sent',
            'funding_confirmed',
            'wave_funded',
            'piece_sent',
            'piece_skipped',
            'manifest_sent',
            'wave_confirmed',
            'assembly_waiting',
            'complete',
        ]);
        assert.strictEqual(Object.isFrozen(MULTIPART_PROGRESS_STEPS), true);
    });
});

describe('multipart progress unknown steps', function () {
    it('refuses an unknown step and names it without invoking the callback', function () {
        let calls = 0;
        const progress = makeProgressEmitter(() => { calls += 1; }, { totalPieces: 2 });
        assert.throws(() => progress.emit('piece_lost'), /Unknown multipart progress step: piece_lost/);
        assert.strictEqual(calls, 0);
        assert.deepStrictEqual(progress.counts(), {
            sent: 0, skipped: 0, totalPieces: 2, callbackErrors: 0,
        });
    });
});

describe('multipart progress running counters', function () {
    it('extends every payload with counters after mixed events', function () {
        const received = [];
        const progress = makeProgressEmitter((step, payload) => {
            received.push([step, payload]);
        }, { totalPieces: 3 });

        progress.emit('planned', { uploadId: 'abc', sent: 99 });
        progress.emit('piece_sent', { piece: 0 });
        progress.emit('piece_skipped', { piece: 1 });
        progress.emit('piece_sent', { piece: 2 });

        assert.deepStrictEqual(received, [
            ['planned', { uploadId: 'abc', sent: 0, skipped: 0, totalPieces: 3 }],
            ['piece_sent', { piece: 0, sent: 1, skipped: 0, totalPieces: 3 }],
            ['piece_skipped', { piece: 1, sent: 1, skipped: 1, totalPieces: 3 }],
            ['piece_sent', { piece: 2, sent: 2, skipped: 1, totalPieces: 3 }],
        ]);
        assert.deepStrictEqual(progress.counts(), {
            sent: 2, skipped: 1, totalPieces: 3, callbackErrors: 0,
        });
    });
});

describe('multipart progress synchronous callback failure', function () {
    it('swallows a throw and counts the callback error', function () {
        const progress = makeProgressEmitter(() => { throw new Error('UI failed'); }, { totalPieces: 1 });
        assert.doesNotThrow(() => progress.emit('piece_sent', { piece: 0 }));
        assert.deepStrictEqual(progress.counts(), {
            sent: 1, skipped: 0, totalPieces: 1, callbackErrors: 1,
        });
    });
});

describe('multipart progress asynchronous callback failure', function () {
    it('handles a rejected promise and counts the callback error', async function () {
        const progress = makeProgressEmitter(
            async () => { throw new Error('async UI failed'); },
            { totalPieces: 1 },
        );
        assert.doesNotThrow(() => progress.emit('piece_skipped', { piece: 0 }));
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepStrictEqual(progress.counts(), {
            sent: 0, skipped: 1, totalPieces: 1, callbackErrors: 1,
        });
    });
});

describe('multipart progress without a callback', function () {
    it('makes emits no-ops that still update counters', function () {
        const progress = makeProgressEmitter(undefined, { totalPieces: 2 });
        assert.doesNotThrow(() => {
            progress.emit('piece_sent', { piece: 0 });
            progress.emit('piece_skipped', { piece: 1 });
            progress.emit('complete');
        });
        assert.deepStrictEqual(progress.counts(), {
            sent: 1, skipped: 1, totalPieces: 2, callbackErrors: 0,
        });
    });
});
