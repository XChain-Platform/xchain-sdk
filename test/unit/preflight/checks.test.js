'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Per-action Tier-2 matrix suite (spec §4.4), ground-truthed against
// the indexer handlers. Emphasis on the corrected rows from the
// ground-truthing pass and the never-error invariants (false-block).

const { expect } = require('chai');
const { mockSdk, notFound } = require('./_mock.js');

// Run a report against a set of endpoint stubs; Tier 1 is neutralized
// (feeExempt => no verdict) so Tier-2 findings stand on their own.
function reportFor(wire, explorerSpec, opts = {}) {
    const sdk = mockSdk({ explorerSpec: { getFeeQuote: () => ({ feeExempt: true }), ...explorerSpec } });
    return sdk.preflight(wire, { source: opts.source || 'me', preflight: opts.mode || 'report', ...opts });
}

const codes = r => r.findings.map(f => f.code + ':' + f.severity);
const has = (r, code, sev) => r.findings.some(f => f.code === code && (!sev || f.severity === sev));

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

    describe('ISSUE (existence != reject; ownership gate)', function () {
        it('existing token owned by someone else is a NOT_OWNER error', async function () {
            const r = await reportFor('ISSUE|1|JDOG|new desc', {
                getToken: () => ({ tick: 'JDOG', owner: 'someone-else' }),
            });
            expect(has(r, 'NOT_OWNER', 'error')).to.equal(true);
        });

        it('existing token owned by the caller is fine (edit)', async function () {
            const r = await reportFor('ISSUE|1|JDOG|new desc', {
                getToken: () => ({ tick: 'JDOG', owner: 'me' }),
            }, { source: 'me' });
            expect(has(r, 'NOT_OWNER')).to.equal(false);
        });

        it('nonexistent token is a fresh create, NOT a reject', async function () {
            const r = await reportFor('ISSUE|0|NEWTOK|1000', { getToken: () => notFound() });
            expect(has(r, 'NOT_OWNER')).to.equal(false);
            expect(has(r, 'TOKEN_NOT_FOUND')).to.equal(false); // ISSUE excluded from token-exists
        });
    });

    describe('MINT (two caps, no fee)', function () {
        it('over MAX_MINT per-tx is an error', async function () {
            const r = await reportFor('MINT|0|JDOG|1000', {
                getToken: () => ({ tick: 'JDOG', max_mint: '100', decimals: '0' }),
            });
            expect(has(r, 'MINT_OVER_MAX', 'error')).to.equal(true);
        });

        it('over remaining supply headroom is an error', async function () {
            const r = await reportFor('MINT|0|JDOG|50', {
                getToken: () => ({ tick: 'JDOG', max_supply: '100', supply: '80', decimals: '0' }),
            });
            expect(has(r, 'SUPPLY_EXCEEDED', 'error')).to.equal(true);
        });
    });

    describe('SWEEP (empty is a valid no-op)', function () {
        it('never emits a balance error; state is unverified', async function () {
            const r = await reportFor('SWEEP|0|bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', {});
            expect(r.findings.every(f => f.severity !== 'error')).to.equal(true);
            expect(r.unverified.some(u => /SWEEP/.test(u.check))).to.equal(true);
        });
    });

    describe('AIRDROP (null AMOUNT is a warning, never an error)', function () {
        it('null AMOUNT does not hard-block', async function () {
            const r = await reportFor('AIRDROP|0|JDOG||55', {
                getToken: () => ({ tick: 'JDOG' }),
                getLists: () => [{ action_index: 55 }],
            });
            expect(r.findings.every(f => f.severity !== 'error')).to.equal(true);
            expect(has(r, 'AMOUNT_NOT_POSITIVE', 'warning')).to.equal(true);
        });

        it('missing LIST is an error', async function () {
            const r = await reportFor('AIRDROP|0|JDOG|1|55', {
                getToken: () => ({ tick: 'JDOG' }),
                getLists: () => notFound(),
            });
            expect(has(r, 'LIST_NOT_FOUND', 'error')).to.equal(true);
        });
    });

    describe('DISPENSE (Tier 1 cannot validate; moves native coin)', function () {
        it('dispenser not open is an error', async function () {
            const r = await reportFor('DISPENSE|0|42', {
                getDispensers: () => [{ action_index: 42, give_amount: '1', give_escrow: '10' }],
                getDispenserCloses: () => [{ block_index: 5 }],
                getDispenserExpires: () => [],
                getDispenserCancels: () => [],
                getDispenses: () => [],
            });
            expect(has(r, 'DISPENSER_NOT_OPEN', 'error')).to.equal(true);
        });

        it('open dispenser with headroom passes the dispense checks', async function () {
            const r = await reportFor('DISPENSE|0|42', {
                getDispensers: () => [{ action_index: 42, give_amount: '1', give_escrow: '10' }],
                getDispenserCloses: () => [],
                getDispenserExpires: () => [],
                getDispenserCancels: () => [],
                getDispenses: () => [{ give_amount: '3' }],
            });
            expect(has(r, 'DISPENSER_NOT_OPEN')).to.equal(false);
            expect(has(r, 'DISPENSER_EMPTY')).to.equal(false);
        });

        it('drained dispenser (remaining < one fill) is an error', async function () {
            const r = await reportFor('DISPENSE|0|42', {
                getDispensers: () => [{ action_index: 42, give_amount: '5', give_escrow: '10' }],
                getDispenserCloses: () => [],
                getDispenserExpires: () => [],
                getDispenserCancels: () => [],
                getDispenses: () => [{ give_amount: '8' }],
            });
            expect(has(r, 'DISPENSER_EMPTY', 'error')).to.equal(true);
        });
    });

    describe('VOTE (re-vote legal; state unverified)', function () {
        it('never hard-blocks a cast ballot on re-vote grounds', async function () {
            const r = await reportFor('VOTE|1|55|1|memo', {});
            expect(r.findings.every(f => f.severity !== 'error')).to.equal(true);
            expect(r.unverified.some(u => /VOTE/.test(u.check))).to.equal(true);
        });
    });

    describe('EXECUTE (no method-existence check in handler)', function () {
        it('surfaces the runtime-revert-with-fee note as unverified, never a block', async function () {
            const r = await reportFor('EXECUTE|0|9|maybeBadMethod|arg', {});
            expect(r.findings.every(f => f.severity !== 'error')).to.equal(true);
            expect(r.unverified.some(u => u.check === 'EXECUTE_STATE')).to.equal(true);
        });
    });

    describe('COINPAY (fee-exempt; Tier 1 gives no verdict)', function () {
        it('does not false-PASS on the feeExempt response', async function () {
            const r = await reportFor('COINPAY|0|42', {});
            // No DRYRUN_VALID should appear from a feeExempt response.
            expect(has(r, 'DRYRUN_VALID')).to.equal(false);
        });
    });
});
