'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect, has, notFound, reportFor } = require('./helpers/setup.js');

describe('pre-flight Tier-2 per-action matrix', function () {

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
    });
});

describe('pre-flight Tier-2 per-action matrix', function () {

    describe('ISSUE (existence != reject; ownership gate)', function () {

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
});
