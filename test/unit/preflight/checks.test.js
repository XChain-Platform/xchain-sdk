'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Per-action Tier-2 matrix suite (spec §4.4), ground-truthed against
// the indexer handlers. Emphasis on the corrected rows from the
// ground-truthing pass and the never-error invariants (false-block).

const { expect, has, reportFor } = require('./checks.test/helpers/setup.js');

describe('pre-flight Tier-2 per-action matrix', function () {

    describe('SEND', function () {
        it('balance shortfall is an overridable error', async function () {
            const r = await reportFor('SEND|0|JDOG|10|bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', {
                getToken: () => ({ tick: 'JDOG' }),
                getBalances: () => [{ tick: 'JDOG', amount: '5' }],
            });
            const f = r.findings.find(x => x.code === 'BALANCE_INSUFFICIENT');
            expect(f.severity).to.equal('error');
            expect(f.overridable).to.equal(true);
        });

        it('sufficient balance does not error on balance', async function () {
            const r = await reportFor('SEND|0|JDOG|1|bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', {
                getToken: () => ({ tick: 'JDOG' }),
                getBalances: () => [{ tick: 'JDOG', amount: '5' }],
            });
            expect(has(r, 'BALANCE_INSUFFICIENT', 'error')).to.equal(false);
        });

        it('multi-leg SEND sums per tick', async function () {
            const r = await reportFor('SEND|1|JDOG|6|a|6|b|m', {
                getToken: () => ({ tick: 'JDOG' }),
                getBalances: () => [{ tick: 'JDOG', amount: '10' }],
            });
            // 6+6 = 12 > 10 balance
            expect(has(r, 'BALANCE_INSUFFICIENT', 'error')).to.equal(true);
        });

        it('localDeltas (pending) reduce the effective balance', async function () {
            const r = await reportFor('SEND|0|JDOG|6|bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', {
                getToken: () => ({ tick: 'JDOG' }),
                getBalances: () => [{ tick: 'JDOG', amount: '10' }],
            }, { localDeltas: [{ tick: 'JDOG', amount: '5' }] });
            // 10 - 5 pending = 5, less than 6
            expect(has(r, 'BALANCE_INSUFFICIENT', 'error')).to.equal(true);
        });
    });
});
