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
const unverified = (r, check) => (r.unverified || []).some(u => u.check === check);

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

        // MAX_SUPPLY fractional precision at the decimals CONSENSUS uses.
        // ISSUE v0 is VERSION|TICK|MAX_SUPPLY|MAX_MINT|DECIMALS|...
        it('a fractional MAX_SUPPLY on a CREATE with DECIMALS 0 is an error', async function () {
            const r = await reportFor('ISSUE|0|NEWTOK|1.5||0', { getToken: () => notFound() });
            expect(has(r, 'AMOUNT_FORMAT_INVALID', 'error')).to.equal(true);
        });

        it('a fractional MAX_SUPPLY within the created DECIMALS is fine', async function () {
            const r = await reportFor('ISSUE|0|NEWTOK|1.5||1', { getToken: () => notFound() });
            expect(has(r, 'AMOUNT_FORMAT_INVALID')).to.equal(false);
        });

        // The re-issue case the static validator cannot decide: the wire DECIMALS is stale
        // and the ROW's 8 decimals are what issue.js:258 measures against, so this is legal
        // on-chain and must not be flagged.
        it('a stale wire DECIMALS does not flag a supply the token row allows', async function () {
            const r = await reportFor('ISSUE|0|JDOG|1000.5||0', {
                getToken: () => ({ tick: 'JDOG', owner: 'me', decimals: 8 }),
            }, { source: 'me' });
            expect(has(r, 'AMOUNT_FORMAT_INVALID')).to.equal(false);
        });

        // And the mirror: the row says 0 decimals, so a fractional supply IS a reject even
        // though the wire claimed 8.
        it('the token row decimals win over a permissive wire DECIMALS', async function () {
            const r = await reportFor('ISSUE|0|JDOG|1000.5||8', {
                getToken: () => ({ tick: 'JDOG', owner: 'me', decimals: 0 }),
            }, { source: 'me' });
            expect(has(r, 'AMOUNT_FORMAT_INVALID', 'error')).to.equal(true);
        });

        // Consensus resolves NaN decimals when neither side names one, and caps nothing.
        it('no decimals on either side asserts nothing', async function () {
            const r = await reportFor('ISSUE|0|NEWTOK|1.5', { getToken: () => notFound() });
            expect(has(r, 'AMOUNT_FORMAT_INVALID')).to.equal(false);
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

    // The flat fixtures above are a HEDGE for other explorer builds, and they
    // are the only shape this suite used to know. The real /token/{tick}
    // document is nested and carries none of those fields at the top level, so
    // MINT_OVER_MAX, SUPPLY_EXCEEDED, AMOUNT_FORMAT_INVALID and NOT_OWNER could
    // not fire against the live API at all - four certified error-capable
    // checks silently passing everything. Captured from
    // /RBTC/api/token/XCHAIN on the regtest explorer.
    describe('MINT / ISSUE against the REAL nested token document', function () {
        const realToken = (over = {}) => ({
            info:   { coin: 'BTC', tick: 'JDOG', description: '', owner: 'someone-else', tick_id: 1, decimals: 0 },
            mints:  { max: 100, address_max: 0, start_block: 0, stop_block: 0 },
            supply: { current: '80', max: '100', decimals: 0 },
            // Every one of these is a LOCK FLAG, never a value. A flat
            // `max_mint` lookup must not be allowed to drift onto them.
            locks:  { callback: false, description: false, max_mint: true, max_supply: true, mint: false, mint_supply: false, sleep: false },
            market: { price: '0', floor: '0' },
            lists:  { allow: null, block: null },
            controllers: [], callback: null, open_polls: [], projects: [], registry: null,
            ...over,
        });

        it('reads the per-tx cap from mints.max', async function () {
            const r = await reportFor('MINT|0|JDOG|1000', { getToken: () => realToken() });
            const f = r.findings.find(x => x.code === 'MINT_OVER_MAX');
            expect(f, 'MINT_OVER_MAX must fire against the real document').to.not.equal(undefined);
            expect(f.data.maxMint).to.equal('100');
        });

        it('reads supply headroom from supply.max and supply.current', async function () {
            const r = await reportFor('MINT|0|JDOG|50', { getToken: () => realToken() });
            const f = r.findings.find(x => x.code === 'SUPPLY_EXCEEDED');
            expect(f, 'SUPPLY_EXCEEDED must fire against the real document').to.not.equal(undefined);
            expect(f.data.headroom).to.equal('20');
        });

        // Top-level `supply` IS an object here. Stringifying it would put
        // '[object Object]' into the numeric comparison.
        it('never stringifies the nested supply object into the numeric path', async function () {
            const r = await reportFor('MINT|0|JDOG|50', { getToken: () => realToken() });
            const f = r.findings.find(x => x.code === 'SUPPLY_EXCEEDED');
            expect(f.data.supply).to.equal('80');
            expect(JSON.stringify(r.findings)).to.not.match(/object Object/);
        });

        it('reads decimals from the nested document (AMOUNT_FORMAT_INVALID is a hard block)', async function () {
            const r = await reportFor('MINT|0|JDOG|1.5', { getToken: () => realToken() });
            const f = r.findings.find(x => x.code === 'AMOUNT_FORMAT_INVALID');
            expect(f, 'a fractional mint on a 0-decimal token must hard-block').to.not.equal(undefined);
            expect(f.overridable).to.equal(false);
        });

        it('reads the owner from info.owner', async function () {
            const r = await reportFor('ISSUE|1|JDOG|new desc', { getToken: () => realToken() });
            expect(has(r, 'NOT_OWNER', 'error')).to.equal(true);
        });

        it('does not fire NOT_OWNER when info.owner is the caller', async function () {
            const r = await reportFor('ISSUE|1|JDOG|new desc',
                { getToken: () => realToken({ info: { tick: 'JDOG', owner: 'me', decimals: 0 } }) },
                { source: 'me' });
            expect(has(r, 'NOT_OWNER')).to.equal(false);
        });

        it('does not mistake a lock flag for a cap', async function () {
            // mints.max absent, locks.max_mint true. Reading the lock would
            // yield maxMint='true' and compare a number against it.
            const tok = realToken({ mints: { address_max: 0, start_block: 0, stop_block: 0 } });
            const r = await reportFor('MINT|0|JDOG|1000', { getToken: () => tok });
            const f = r.findings.find(x => x.code === 'MINT_OVER_MAX');
            expect(f, 'no cap is knowable, so no cap finding').to.equal(undefined);
        });

        it('mints.max of 0 (ISSUE omitted MAX_MINT) is not a zero cap', async function () {
            // xchain-indexer stores MAX_MINT as 0 when an ISSUE omits it and
            // treats 0 as "no per-tx cap" (mint.js bcgt(MAX_MINT,0) guard).
            // A token issued via the wallet's ISSUE quick-form regularly
            // lands here (see xchain-wallet IssueTokenForm.jsx, no MAX_MINT
            // field): every real mint on it must not be flagged as over-cap.
            const tok = realToken({ mints: { max: 0, address_max: 0, start_block: 0, stop_block: 0 } });
            const r = await reportFor('MINT|0|JDOG|1000', { getToken: () => tok });
            const f = r.findings.find(x => x.code === 'MINT_OVER_MAX');
            expect(f, 'MAX_MINT=0 means uncapped, not a zero-mint cap').to.equal(undefined);
        });

        // The MAX_SUPPLY twin of the case above, and the sharper one: '0' is a
        // truthy STRING, so the headroom path ran with maxSupply=0 and produced a
        // NEGATIVE headroom, making every mint on an uncapped token an error. At/after
        // the UNCAPPED_MAX_SUPPLY_ZERO flag-day the chain accepts exactly these mints
        // (xchain-indexer src/actions/mint.js), so the finding is a false
        // block of a valid action, which spec §4.2 forbids.
        it('supply.max of 0 (ISSUE omitted MAX_SUPPLY) is uncapped, not a zero ceiling', async function () {
            const tok = realToken({ supply: { current: '80', max: '0', decimals: 0 } });
            const r = await reportFor('MINT|0|JDOG|50', { getToken: () => tok });
            const f = r.findings.find(x => x.code === 'SUPPLY_EXCEEDED');
            expect(f, 'MAX_SUPPLY=0 means uncapped, not a zero supply ceiling').to.equal(undefined);
        });

        // Guards the fix from being written as "skip whenever the numbers look odd":
        // a real positive cap must still block, headroom and all.
        it('still enforces a real positive supply cap', async function () {
            const r = await reportFor('MINT|0|JDOG|50', { getToken: () => realToken() });
            const f = r.findings.find(x => x.code === 'SUPPLY_EXCEEDED');
            expect(f, 'a declared cap must still fire').to.not.equal(undefined);
            expect(f.data.headroom).to.equal('20');
        });

        // The uncapped case must be DECLARED, not silently dropped: below the
        // flag-day the chain still rejects these mints, and a client that says
        // nothing is indistinguishable from one that checked and approved.
        it('declares the uncapped supply ceiling as unverified rather than passing silently', async function () {
            const tok = realToken({ supply: { current: '80', max: '0', decimals: 0 } });
            const r = await reportFor('MINT|0|JDOG|50', { getToken: () => tok });
            expect(unverified(r, 'SUPPLY_EXCEEDED'),
                'an uncapped token must declare the ceiling unverified').to.equal(true);
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
        // A LIST is resolved by ACTION INDEX, so the lookup is the action-detail
        // route. /lists/ takes block or address only; keying it by action_index
        // 404'd, which made every airdrop against a real list read as an airdrop
        // against a missing one.
        it('null AMOUNT does not hard-block', async function () {
            const r = await reportFor('AIRDROP|0|JDOG||55', {
                getToken: () => ({ tick: 'JDOG' }),
                getAction: () => ({ action: 'LIST', action_index: '55' }),
            });
            expect(r.findings.every(f => f.severity !== 'error')).to.equal(true);
            expect(has(r, 'AMOUNT_NOT_POSITIVE', 'warning')).to.equal(true);
        });

        it('an existing list is not reported missing', async function () {
            const r = await reportFor('AIRDROP|0|JDOG|1|55', {
                getToken: () => ({ tick: 'JDOG' }),
                getAction: () => ({ action: 'LIST', action_index: '55' }),
            });
            expect(has(r, 'LIST_NOT_FOUND')).to.equal(false);
        });

        it('missing LIST is an error', async function () {
            const r = await reportFor('AIRDROP|0|JDOG|1|55', {
                getToken: () => ({ tick: 'JDOG' }),
                getAction: () => notFound(),
            });
            expect(has(r, 'LIST_NOT_FOUND', 'error')).to.equal(true);
        });

        it('an action index that is not a LIST is an error', async function () {
            const r = await reportFor('AIRDROP|0|JDOG|1|55', {
                getToken: () => ({ tick: 'JDOG' }),
                getAction: () => ({ action: 'SEND', action_index: '55' }),
            });
            expect(has(r, 'LIST_NOT_FOUND', 'error')).to.equal(true);
        });
    });
    // Fixtures below mirror a REAL payload captured from the regtest explorer
    // (`/RBTC/api/action/3543`, an open XCHAIN dispenser), not an imagined
    // shape. The previous fixtures invented `/dispensers/` + three lifecycle
    // streams keyed by action index; no such routes exist, so the suite was
    // green over an API that 404s in production and every live DISPENSE
    // pre-flight answered "dispenser does not exist".
    const dispenserAction = (over = {}, state = {}) => ({
        action: 'DISPENSER',
        action_index: '42',
        source: 'me',
        get_address: 'me',
        give_coin: 'BTC',
        give_tick: 'XCHAIN',
        give_amount: '25',
        give_escrow: '100',
        get_amount: '5',
        oracle_address: null,
        status: 'valid',
        ...over,
        state: { give_remaining: '100', expiration: '1792923623', status: 'open', ...state },
    });

    describe('DISPENSE (Tier 1 cannot validate; moves native coin)', function () {
        it('an open, funded dispenser is not blocked', async function () {
            const r = await reportFor('DISPENSE|0|42', {
                getAction: () => dispenserAction(),
            });
            expect(has(r, 'DISPENSER_NOT_FOUND')).to.equal(false);
            expect(has(r, 'DISPENSER_NOT_OPEN')).to.equal(false);
            expect(has(r, 'DISPENSER_EMPTY')).to.equal(false);
            expect(r.findings.every(f => f.severity !== 'error')).to.equal(true);
        });

        it('dispenser not open is an error', async function () {
            const r = await reportFor('DISPENSE|0|42', {
                getAction: () => dispenserAction({}, { status: 'closed' }),
            });
            expect(has(r, 'DISPENSER_NOT_OPEN', 'error')).to.equal(true);
        });

        // The indexer keeps minting new terminal statuses (`empty`,
        // `max_dispenses_reached` from the refill caps). Gating on
        // anything-but-open is what keeps this from going stale each time.
        it('treats an unrecognised terminal status as not-open', async function () {
            const r = await reportFor('DISPENSE|0|42', {
                getAction: () => dispenserAction({}, { status: 'max_dispenses_reached' }),
            });
            expect(has(r, 'DISPENSER_NOT_OPEN', 'error')).to.equal(true);
        });

        it('drained dispenser (remaining < one fill) is an error', async function () {
            const r = await reportFor('DISPENSE|0|42', {
                getAction: () => dispenserAction({ give_amount: '25' }, { give_remaining: '10' }),
            });
            expect(has(r, 'DISPENSER_EMPTY', 'error')).to.equal(true);
        });

        // give_remaining on the action route already nets refills in
        // (explorer db.js: escrow + refills - dispenses), which is precisely
        // why it is read instead of rebuilt from the opening escrow.
        it('honours a give_remaining ABOVE the opening escrow (refilled)', async function () {
            const r = await reportFor('DISPENSE|0|42', {
                getAction: () => dispenserAction({ give_escrow: '100' }, { give_remaining: '500' }),
            });
            expect(has(r, 'DISPENSER_EMPTY')).to.equal(false);
        });

        it('an action index that is not a dispenser does not exist', async function () {
            const r = await reportFor('DISPENSE|0|42', {
                getAction: () => ({ action: 'SEND', action_index: '42' }),
            });
            expect(has(r, 'DISPENSER_NOT_FOUND', 'error')).to.equal(true);
        });

        it('a 404 on the lookup is an authoritative "does not exist"', async function () {
            const r = await reportFor('DISPENSE|0|42', { getAction: () => notFound() });
            expect(has(r, 'DISPENSER_NOT_FOUND', 'error')).to.equal(true);
        });

        // Degradation, not a verdict: an unreachable explorer must never
        // manufacture either a block or a pass (§4.2).
        it('an unreachable explorer is unverified, never an error', async function () {
            const r = await reportFor('DISPENSE|0|42', {
                getAction: () => { throw new Error('explorer down'); },
            });
            expect(r.findings.every(f => f.severity !== 'error')).to.equal(true);
            expect(unverified(r, 'DISPENSER_NOT_FOUND')).to.equal(true);
        });

        // Silence would read as headroom on an action that moves native coin.
        it('declares status and give-remaining unverified when the state block is absent', async function () {
            const r = await reportFor('DISPENSE|0|42', {
                getAction: () => ({ action: 'DISPENSER', action_index: '42', give_amount: '25' }),
            });
            expect(has(r, 'DISPENSER_NOT_OPEN')).to.equal(false);
            expect(has(r, 'DISPENSER_EMPTY')).to.equal(false);
            expect(unverified(r, 'DISPENSER_NOT_OPEN')).to.equal(true);
            expect(unverified(r, 'DISPENSER_EMPTY')).to.equal(true);
        });
    });

    describe('DISPENSER refill (refill cap + oracle fee)', function () {
        it('declares the refill cap unverified: no endpoint exposes per-edit escrow', async function () {
            const r = await reportFor('DISPENSER|2|42|100', {
                getAction: () => dispenserAction(),
            });
            expect(has(r, 'DISPENSER_MAX_REFILLS')).to.equal(false);
            expect(unverified(r, 'DISPENSER_MAX_REFILLS')).to.equal(true);
        });

        it('an edit that does not top up escrow is not refill-checked at all', async function () {
            const r = await reportFor('DISPENSER|2|42||1799999999', {
                getAction: () => dispenserAction(),
            });
            expect(unverified(r, 'DISPENSER_MAX_REFILLS')).to.equal(false);
        });

        it('declares the oracle usage fee unverified on a Mode B open', async function () {
            const r = await reportFor('DISPENSER|0|BTC|JDOG|1|0|100|BTC|BTC|1||USD||orc1', {});
            expect(unverified(r, 'DISPENSER_ORACLE_FEE')).to.equal(true);
        });

        it('says nothing about an oracle fee on a Mode A dispenser', async function () {
            const r = await reportFor('DISPENSER|0|BTC|JDOG|1|0|100|BTC|BTC|1||USD|1', {});
            expect(unverified(r, 'DISPENSER_ORACLE_FEE')).to.equal(false);
        });

        // A v2 refill never restates the oracle, so it has to come off the
        // dispenser being refilled.
        it('declares the oracle fee unverified on a Mode B refill', async function () {
            const r = await reportFor('DISPENSER|2|42|100', {
                getAction: () => dispenserAction({ oracle_address: 'orc1' }),
            });
            expect(unverified(r, 'DISPENSER_ORACLE_FEE')).to.equal(true);
        });

        it('says nothing about an oracle fee when refilling a Mode A dispenser', async function () {
            const r = await reportFor('DISPENSER|2|42|100', {
                getAction: () => dispenserAction(),
            });
            expect(unverified(r, 'DISPENSER_ORACLE_FEE')).to.equal(false);
        });
    });

    // An ownership dispenser never holds balance escrow, on edit as on create.
    // The create-time half is authoring-only and already lives in validator.js;
    // an EDIT never restates GIVE_OWNERSHIP, so only a state lookup can see it
    // (xchain-indexer src/actions/dispenser.js).
    describe('DISPENSER ownership-escrow edit', function () {
        it('warns when an edit tops up escrow on an ownership dispenser', async function () {
            const r = await reportFor('DISPENSER|2|42|100', {
                getAction: () => dispenserAction({ give_ownership: 1 }),
            });
            expect(has(r, 'DISPENSER_OWNERSHIP_ESCROW', 'warning'),
                'an ownership dispenser cannot take escrow on edit').to.equal(true);
        });

        // Activation-gated on the chain (dispenser-family cohort) and pre-flight
        // has no height, so this can never be a hard block: spec §4.2.
        it('never hard-blocks on it', async function () {
            const r = await reportFor('DISPENSER|2|42|100', {
                getAction: () => dispenserAction({ give_ownership: 1 }),
            });
            const f = r.findings.find(x => x.code === 'DISPENSER_OWNERSHIP_ESCROW');
            expect(f.severity).to.not.equal('error');
        });

        // The handler guards with isNull, NOT isPositive, so a supplied zero is
        // still a supplied GIVE_ESCROW and still rejected. The refill path below
        // returns early on non-positive, which is why this sits ahead of it.
        it('fires on a supplied GIVE_ESCROW of 0, which the refill path ignores', async function () {
            const r = await reportFor('DISPENSER|2|42|0', {
                getAction: () => dispenserAction({ give_ownership: 1 }),
            });
            expect(has(r, 'DISPENSER_OWNERSHIP_ESCROW', 'warning')).to.equal(true);
        });

        it('says nothing on an ordinary (non-ownership) dispenser refill', async function () {
            const r = await reportFor('DISPENSER|2|42|100', {
                getAction: () => dispenserAction(),
            });
            expect(has(r, 'DISPENSER_OWNERSHIP_ESCROW')).to.equal(false);
        });

        it('says nothing when the edit supplies no GIVE_ESCROW at all', async function () {
            const r = await reportFor('DISPENSER|2|42||1799999999', {
                getAction: () => dispenserAction({ give_ownership: 1 }),
            });
            expect(has(r, 'DISPENSER_OWNERSHIP_ESCROW')).to.equal(false);
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

    describe('native-fee forfeiture disclosure (FEE_CHARGING_ACTIONS)', function () {
        it('BET warns about native-fee forfeiture like every other fee-charging action', async function () {
            // bet.js calls createFeesObject and takes the paymentMode === 'native'
            // branch, so a BET paid in native coin forfeits it exactly as ORDER does.
            const r = await reportFor('BET|2|42|1|100|memo', {});
            expect(has(r, 'NATIVE_FEE_FORFEIT', 'warning')).to.equal(true);
        });

        it('an ORDER still warns (the identically-exposed control)', async function () {
            const r = await reportFor('ORDER|0|JDOG|10|XCHAIN|20|100', {});
            expect(has(r, 'NATIVE_FEE_FORFEIT', 'warning')).to.equal(true);
        });

        it('a non-fee action (SEND) still says nothing about forfeiture', async function () {
            const r = await reportFor('SEND|0|JDOG|1|bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', {
                getToken: () => ({ tick: 'JDOG' }),
                getBalances: () => [{ tick: 'JDOG', amount: '5' }],
            });
            expect(has(r, 'NATIVE_FEE_FORFEIT')).to.equal(false);
        });
    });
});
