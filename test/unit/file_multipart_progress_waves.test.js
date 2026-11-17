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
const { makeProgressEmitter } = require('../../src/file/multipart_progress.js');

describe('multipart progress wave steps', function () {
    it('forwards wave fields without changing the piece counters', function () {
        const received = [];
        const progress = makeProgressEmitter((step, payload) => {
            received.push([step, payload]);
        }, { totalPieces: 4 });

        progress.emit('piece_sent', { piece: 0 });
        progress.emit('piece_skipped', { piece: 1 });
        received.length = 0;

        progress.emit('wave_funded', { wave: 1, waves: 3, txid: 'funding-tx' });
        progress.emit('wave_confirmed', { wave: 1, waves: 3 });

        assert.deepStrictEqual(received, [
            ['wave_funded', {
                wave: 1,
                waves: 3,
                txid: 'funding-tx',
                sent: 1,
                skipped: 1,
                totalPieces: 4,
            }],
            ['wave_confirmed', {
                wave: 1,
                waves: 3,
                sent: 1,
                skipped: 1,
                totalPieces: 4,
            }],
        ]);
        assert.deepStrictEqual(progress.counts(), {
            sent: 1, skipped: 1, totalPieces: 4, callbackErrors: 0,
        });
    });

    it('still refuses an unknown wave step', function () {
        const progress = makeProgressEmitter(() => {}, { totalPieces: 1 });

        assert.throws(
            () => progress.emit('wave_lost'),
            /Unknown multipart progress step: wave_lost/,
        );
    });
});
