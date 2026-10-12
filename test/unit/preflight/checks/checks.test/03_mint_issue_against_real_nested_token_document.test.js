'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect, has, reportFor, unverified } = require('./helpers/setup.js');

    // The flat fixtures above are a HEDGE for other explorer builds, and they
    // are one shape this suite exercises, not the only shape live data takes.
    // The real /token/{tick}
    // document is nested and carries none of those fields at the top level, so
    // MINT_OVER_MAX, SUPPLY_EXCEEDED, AMOUNT_FORMAT_INVALID and NOT_OWNER could
    // not fire against the live API at all - four certified error-capable
    // checks silently passing everything. Captured from
    // /RBTC/api/token/XCHAIN on the regtest explorer.
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

describe('pre-flight Tier-2 per-action matrix', function () {

    describe('MINT / ISSUE against the REAL nested token document', function () {
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
    });
});

describe('pre-flight Tier-2 per-action matrix', function () {

    describe('MINT / ISSUE against the REAL nested token document', function () {
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
    });
});

    // The producer-side precision contract, pinned from the consumer end. The
    // explorer serves mints.max as a decimal string at the token's decimals; when
    // it served a JS float instead, a cap of 100000000.00000002 arrived as
    // 100000000.00000001 and a mint of exactly the configured cap was rejected.
    const precisionToken = (max) => realToken({
        info:   { coin: 'BTC', tick: 'JDOG', description: '', owner: 'someone-else', tick_id: 1, decimals: 8 },
        mints:  { max, address_max: null, start_block: 0, stop_block: 0 },
        supply: { current: '0', max: '0', decimals: 8 },
    });

describe('pre-flight Tier-2 per-action matrix', function () {

    describe('MINT / ISSUE against the REAL nested token document', function () {
        it('does not flag a mint equal to a high-precision decimal-string cap', async function () {
            const tok = precisionToken('100000000.00000002');
            const r = await reportFor('MINT|0|JDOG|100000000.00000002', { getToken: () => tok });
            const f = r.findings.find(x => x.code === 'MINT_OVER_MAX');
            expect(f, 'a mint equal to the cap is not over the cap').to.equal(undefined);
        });

        // The negative control for the case above: one ulp over the cap must still
        // fire, and the float-truncated cap the old producer served must fire too.
        // Without these two, the case above would pass on a check that never runs.
        it('still flags a mint above a high-precision cap, and on the truncated cap', async function () {
            const exact = precisionToken('100000000.00000002');
            const over = await reportFor('MINT|0|JDOG|100000000.00000003', { getToken: () => exact });
            expect(over.findings.find(x => x.code === 'MINT_OVER_MAX'),
                'one ulp above the cap must still be flagged').to.not.equal(undefined);

            const truncated = precisionToken(100000000.00000002);
            const lossy = await reportFor('MINT|0|JDOG|100000000.00000002', { getToken: () => truncated });
            expect(lossy.findings.find(x => x.code === 'MINT_OVER_MAX'),
                'the float cap is exactly the failure the producer fix removes').to.not.equal(undefined);
        });
    });
});

describe('pre-flight Tier-2 per-action matrix', function () {

    describe('MINT / ISSUE against the REAL nested token document', function () {
        // The MAX_SUPPLY twin of the case above, and the sharper one: '0' is a
        // truthy STRING, so the headroom path ran with maxSupply=0 and produced a
        // NEGATIVE headroom, making every mint on an uncapped token an error. At/after
        // the UNCAPPED_MAX_SUPPLY_ZERO flag-day the chain accepts exactly these mints
        // (xchain-indexer src/actions/mint.js), so the finding is a false
        // block of a valid action, which protocol rule §4.2 forbids.
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
});
