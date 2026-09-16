'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect, reportFor } = require('./helpers/setup.js');

/*
 * The widened fee-budget priceability mirror (arbiter scope D10): an ORDER /
 * SWAP / DISPENSER format-0 create is priced from its wire EXPIRATION, and an
 * EXECUTE at its VM acceptance floor. The grade split is the load-bearing
 * rule and is pinned here: the EXECUTE floor is a true lower bound and may
 * feed the whole-batch collapse ERROR; a duration quote is taken at the wall
 * clock, which can overstate a later-confirming create, so it feeds the
 * batch-total WARNING only and may never collapse the batch. MINT and XEXEC
 * refuse to price outright.
 */
const feeFinding = (r) => r.findings.find(f => f.code === 'BALANCE_INSUFFICIENT' && f.data && f.data.tick === 'XCHAIN');
// 200 days out: 110 chargeable days x 550 gas x 0.00001 = 0.605 XCHAIN.
const expDays = (days) => String(Math.floor(Date.now() / 1000) + days * 86400);
const gasTokenOnly = (t) => (t === 'XCHAIN' ? { tick: 'XCHAIN', decimals: '8' } : null);
const funded = { getToken: gasTokenOnly, getBalances: () => [{ tick: 'JDOG', amount: '50' }, { tick: 'XCHAIN', amount: '0' }] };

const ORDER = (exp) => 'ORDER|0||JDOG|1|0||GET|2|0||' + exp;
const SWAP = (exp) => 'SWAP|0||JDOG|1|0||GET|2|0||' + exp;
const DISPENSER = (exp) => 'DISPENSER|0||JDOG|1|0|10||GET|1|||||' + exp;
const EXECUTE = 'EXECUTE|0|5|run';

describe('pre-flight BATCH fee budget: priced classes beyond ISSUE', function () {

    it('an ORDER create is priced from its expiration and warns on the total', async function () {
        const r = await reportFor('BATCH|0|' + ORDER(expDays(200)), funded);
        const f = feeFinding(r);
        expect(f, 'a fee finding was raised').to.exist;
        expect(f.severity).to.equal('warning');
        expect(f.data.total).to.equal('0.605');
    });

    it('a SWAP create is priced from its expiration', async function () {
        const r = await reportFor('BATCH|0|' + SWAP(expDays(200)), funded);
        const f = feeFinding(r);
        expect(f, 'a fee finding was raised').to.exist;
        expect(f.data.total).to.equal('0.605');
    });

    it('a DISPENSER create is priced from its expiration', async function () {
        const r = await reportFor('BATCH|0|' + DISPENSER(expDays(200)), funded);
        const f = feeFinding(r);
        expect(f, 'a fee finding was raised').to.exist;
        expect(f.data.total).to.equal('0.605');
    });

    it('an expiration inside the free window prices at zero and raises nothing', async function () {
        const r = await reportFor('BATCH|0|' + ORDER(expDays(30)), funded);
        expect(feeFinding(r)).to.equal(undefined);
    });

    it('no expiration is the free case and raises nothing', async function () {
        const r = await reportFor('BATCH|0|' + ORDER(''), funded);
        expect(feeFinding(r)).to.equal(undefined);
    });

    it('a duration quote NEVER collapses the batch: it is not a lower bound', async function () {
        // Both commands are positively priced and the balance covers neither,
        // yet the verdict must stay a warning: the ORDER quote is taken at the
        // wall clock and the chain prices the CONFIRMING block's time, so a
        // later confirmation can be billed less than the quote. An error here
        // would be the over-collapse the lower-bound discipline forbids.
        const r = await reportFor('BATCH|0|' + ORDER(expDays(200)) + ';' + EXECUTE, funded);
        const f = feeFinding(r);
        expect(f, 'a fee finding was raised').to.exist;
        expect(f.severity).to.equal('warning');
        expect(f.data.wholeBatch).to.equal(undefined);
    });
});

describe('pre-flight BATCH fee budget: priced classes beyond ISSUE', function () {

    it('an all-EXECUTE batch collapses on the VM acceptance floor', async function () {
        const r = await reportFor('BATCH|0|' + [EXECUTE, EXECUTE, EXECUTE].join(';'), funded);
        const f = feeFinding(r);
        expect(f, 'a fee finding was raised').to.exist;
        expect(f.severity).to.equal('error');
        expect(f.data.wholeBatch).to.equal(true);
        expect(f.data.cheapest).to.equal('0.01');
        expect(f.data.total).to.equal('0.03');
    });

    it('a partially funded EXECUTE batch warns with the count that lands', async function () {
        const r = await reportFor('BATCH|0|' + [EXECUTE, EXECUTE, EXECUTE].join(';'), {
            getToken: gasTokenOnly,
            getBalances: () => [{ tick: 'XCHAIN', amount: '0.015' }],
        });
        const f = feeFinding(r);
        expect(f.severity).to.equal('warning');
        expect(f.data.affordable).to.equal(1);
    });

    it('a mixed ISSUE + EXECUTE batch collapses on the cheapest of the two', async function () {
        const r = await reportFor('BATCH|0|ISSUE|0|JDOG.1|1;' + EXECUTE, funded);
        const f = feeFinding(r);
        expect(f.severity).to.equal('error');
        expect(f.data.wholeBatch).to.equal(true);
        expect(f.data.cheapest).to.equal('0.01');
    });
});

describe('pre-flight BATCH fee budget: priced classes beyond ISSUE', function () {

    it('an unresolvable gas token leaves EXECUTE unpriced, exactly as it does on-chain', async function () {
        // The arbiter probes the gas token because a chain without its
        // issuance charges an EXECUTE nothing; an absent row answers unknown.
        const r = await reportFor('BATCH|0|' + [EXECUTE, EXECUTE].join(';'), {
            getToken: () => null,
            getBalances: () => [{ tick: 'XCHAIN', amount: '0' }],
        });
        expect(feeFinding(r)).to.equal(undefined);
    });

    it('an ORDER cancel refuses to price, so no collapse can be claimed', async function () {
        const r = await reportFor('BATCH|0|ORDER|1|5;' + EXECUTE, funded);
        const f = feeFinding(r);
        expect(f, 'the EXECUTE floor still feeds the total').to.exist;
        expect(f.severity).to.equal('warning');
    });

    it('PINNED: MINT refuses to price - an all-MINT no-gas batch raises no fee verdict', async function () {
        // MINT is free on-chain and its real cost is contract code, which no
        // param reveals. Pricing it would invent a number; refusing keeps the
        // all-MINT batch out of every fee verdict, matching the arbiter.
        const r = await reportFor('BATCH|0|MINT|0|JDOG|1;MINT|0|JDOG|2', {
            getToken: (t) => (t === 'JDOG' ? { tick: 'JDOG', decimals: '0' } : gasTokenOnly(t)),
            getBalances: () => [{ tick: 'XCHAIN', amount: '0' }],
        });
        expect(feeFinding(r)).to.equal(undefined);
    });

    it('PINNED: a MINT beside EXECUTEs downgrades the collapse to a warning', async function () {
        const r = await reportFor('BATCH|0|' + EXECUTE + ';MINT|0|JDOG|1', {
            getToken: (t) => (t === 'JDOG' ? { tick: 'JDOG', decimals: '0' } : gasTokenOnly(t)),
            getBalances: () => [{ tick: 'XCHAIN', amount: '0' }],
        });
        const f = feeFinding(r);
        expect(f, 'the EXECUTE floor still feeds the total').to.exist;
        expect(f.severity).to.equal('warning');
        expect(f.data.wholeBatch).to.equal(undefined);
    });

    it('PINNED: XEXEC refuses to price - it cannot even be encoded client-side', async function () {
        // XEXEC is system-injected and fee-less on-chain. It has no client
        // wire format, so it surfaces as an unparseable command, and the
        // batch must not collapse on the EXECUTEs beside it.
        const r = await reportFor('BATCH|0|' + EXECUTE + ';XEXEC|0|1', funded);
        const parseFail = r.findings.find(x => x.code === 'PARSE_INVALID');
        expect(parseFail, 'XEXEC does not parse client-side').to.exist;
        expect(parseFail.data.commandIndex).to.equal(1);
        const f = feeFinding(r);
        expect(f && f.severity).to.not.equal('error');
    });
});
