'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `^<id>` address-reference row of the universal matrix. The indexer
// resolves a wire ^<id> and, at/after the flag-day, hard-rejects one
// that does not resolve; this asserts the
// client mirror says the knowable half out loud and declares the
// unknowable half rather than guessing at it.

const { expect } = require('chai');
const { mockSdk } = require('./_mock.js');
const { CARET_RESOLVED_FIELDS } = require('../../../src/preflight/universal.js');
const { ADDRESS_REF_FIELDS } = require('../../../src/addressRefFields.js');

// Tier 1 neutralized (feeExempt => no verdict) so Tier-2 findings stand alone,
// and every token resolves so TOKEN_NOT_FOUND never masks the row under test.
function reportFor(wire, explorerSpec = {}) {
    const sdk = mockSdk({
        explorerSpec: {
            getFeeQuote: () => ({ feeExempt: true }),
            getToken: () => ({ tick: 'JDOG' }),
            getBalances: () => [{ tick: 'JDOG', amount: '1000' }],
            ...explorerSpec,
        },
    });
    return sdk.preflight(wire, { source: 'me', preflight: 'report' });
}

const CODE = 'CARET_REF_UNRESOLVABLE';
const finding = (r) => r.findings.find((f) => f.code === CODE);
const unverified = (r) => (r.unverified || []).some((u) => u.check === CODE);

const ADDR = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

describe('pre-flight universal: ^<id> address references', function () {

    describe('non-canonical ids (locally decidable)', function () {
        // Each of these fails the indexer's own CANONICAL_CARET_ID, so it cannot
        // resolve on any node in any era: no lookup is needed to know the verdict.
        for (const bad of ['^0', '^007', '^0x10', '^abc', '^-1', '^', '^1.5'])
            it(`flags MINT DESTINATION ${bad}`, async function () {
                const r = await reportFor(`MINT|0|JDOG|10|${bad}|memo`);
                const f = finding(r);
                expect(f, 'expected a ' + CODE + ' finding').to.not.equal(undefined);
                expect(f.severity).to.equal('warning');
                expect(f.data.field).to.equal('DESTINATION');
                expect(f.data.value).to.equal(bad);
            });

        it('never errors, even non-overridably: three call sites still ACCEPT one below the flag-day', async function () {
            // DISPENSER.ORACLE_ADDRESS on a non-oracle dispenser is the sharpest of
            // the three - its format check only runs when usingOracle - so a hard
            // client error would false-block an action the chain takes today.
            const r = await reportFor('DISPENSER|0|BTC|JDOG|1|0|100|BTC||1000|' + ADDR + '|||^007|||memo');
            const f = finding(r);
            expect(f.severity).to.equal('warning');
            expect(f.overridable).to.equal(undefined);
            expect(r.findings.some((x) => x.code === CODE && x.severity === 'error')).to.equal(false);
        });

        it('reports each drifted-handler field it appears in, not just the first', async function () {
            // ISSUE carries two resolved refs, and the genesis path skips the
            // isCryptoAddress checks that used to be the only thing catching them.
            const r = await reportFor('ISSUE|0|JDOG|1000|10|8|desc|0|^0|^abc||||||||||||||memo');
            const fields = r.findings.filter((f) => f.code === CODE).map((f) => f.data.field).sort();
            expect(fields).to.deep.equal(['TRANSFER', 'TRANSFER_SUPPLY']);
        });
    });

    describe('well-formed ids (not decidable client-side)', function () {
        it('declares the dangling case unverified instead of guessing', async function () {
            const r = await reportFor('ORDER|0|BTC|JDOG|10|0|BTC||5|0|^57||||memo');
            expect(finding(r), 'a resolvable-looking ref must not be flagged').to.equal(undefined);
            expect(unverified(r)).to.equal(true);
        });

        it('declares it once per run, however many refs the action carries', async function () {
            const r = await reportFor('ISSUE|0|JDOG|1000|10|8|desc|0|^57|^58||||||||||||||memo');
            expect((r.unverified || []).filter((u) => u.check === CODE).length).to.equal(1);
        });
    });

    describe('fields deliberately out of scope', function () {
        it('says nothing about a full address', async function () {
            const r = await reportFor(`MINT|0|JDOG|10|${ADDR}|memo`);
            expect(finding(r)).to.equal(undefined);
            expect(unverified(r)).to.equal(false);
        });

        it('says nothing about SEND DESTINATION: send.js never resolves, so a ^id is a format reject in both eras', async function () {
            const r = await reportFor('SEND|0|JDOG|10|^007|memo');
            expect(finding(r)).to.equal(undefined);
            expect(unverified(r)).to.equal(false);
        });
    });

    describe('the scoped field set is derived, not restated', function () {
        it('covers every single-value address field of the shared consensus map', function () {
            // The set the indexer calls resolveAddressRefChecked on. Restating it
            // here would be a second list free to drift; derive it the same way the
            // check does and assert the two shapes that must stay excluded.
            for (const action of Object.keys(ADDRESS_REF_FIELDS)) {
                const expected = ADDRESS_REF_FIELDS[action]
                    .filter((s) => !s.multi && !s.listType).map((s) => s.field);
                expect(CARET_RESOLVED_FIELDS[action], action).to.deep.equal(expected);
            }
            expect(CARET_RESOLVED_FIELDS.SEND).to.deep.equal([]);
            expect(CARET_RESOLVED_FIELDS.LIST).to.deep.equal([]);
            // noCompact is about what the SDK EMITS, not what the indexer resolves.
            expect(CARET_RESOLVED_FIELDS.DISPENSER).to.deep.equal(['GET_ADDRESS', 'ORACLE_ADDRESS']);
        });
    });

    /*
     * The `noCompact` pair is decidable even when the id is well-formed, because
     * the DECODER is what cannot resolve it: its address ids are a different
     * sequence, so a compacted GET_ADDRESS registers no dispenser and a compacted
     * ORACLE_ADDRESS captures no oracle-fee output and the create is rejected with
     * the fee spent (addressRefFields.js's consensus note; the decoder logs both).
     * The SDK's own compose path never emits one, so this only fires on a
     * hand-set param, which is exactly the case addressRefFields.js anticipates.
     */
    describe('noCompact fields: a well-formed id is still decidable', function () {
        it('reports a canonical ^<id> on DISPENSER.GET_ADDRESS', async function () {
            const r = await reportFor('DISPENSER|0|BTC|JDOG|1|0|100|BTC||1000|^57|||||memo');
            const f = finding(r);
            expect(f, 'expected a ' + CODE + ' finding').to.not.equal(undefined);
            expect(f.data.field).to.equal('GET_ADDRESS');
            expect(f.data.value).to.equal('^57');
            expect(f.severity).to.equal('warning');
        });

        it('reports a canonical ^<id> on DISPENSER.ORACLE_ADDRESS', async function () {
            const r = await reportFor('DISPENSER|0|BTC|JDOG|1|0|100|BTC||1000|' + ADDR + '|||^57|||memo');
            const f = finding(r);
            expect(f, 'expected a ' + CODE + ' finding').to.not.equal(undefined);
            expect(f.data.field).to.equal('ORACLE_ADDRESS');
            expect(f.severity).to.equal('warning');
        });

        it('stays a WARNING: the chain still takes the transaction, it just cannot use the reference', async function () {
            const r = await reportFor('DISPENSER|0|BTC|JDOG|1|0|100|BTC||1000|^57|||||memo');
            expect(r.findings.some((x) => x.code === CODE && x.severity === 'error')).to.equal(false);
        });

        it('does not report a full address on the same fields', async function () {
            const r = await reportFor('DISPENSER|0|BTC|JDOG|1|0|100|BTC||1000|' + ADDR + '|||||memo');
            expect(finding(r)).to.equal(undefined);
            expect(unverified(r)).to.equal(false);
        });

        it('leaves a compactable field on another action unverified, not reported', async function () {
            // ORDER.GET_ADDRESS carries the same field NAME with no noCompact spec,
            // so the new verdict must be per-action or it false-flags this.
            const r = await reportFor('ORDER|0|BTC|JDOG|10|0|BTC||5|0|^57||||memo');
            expect(finding(r)).to.equal(undefined);
            expect(unverified(r)).to.equal(true);
        });
    });
});
