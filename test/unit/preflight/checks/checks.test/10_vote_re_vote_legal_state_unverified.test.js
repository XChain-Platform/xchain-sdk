'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect, reportFor } = require('./helpers/setup.js');
const { checkMisc } = require('../../../../../src/preflight/checks/misc.js');

async function voteNote(version) {
    const unverified = [];
    await checkMisc({
        parsed: { action: 'VOTE', version },
        addUnverified(check, reason) { unverified.push({ check, reason }); },
    });
    expect(unverified).to.have.length(1);
    return unverified[0];
}

describe('pre-flight Tier-2 per-action matrix', function () {

    describe('VOTE (re-vote legal; state unverified)', function () {
        it('never hard-blocks a cast ballot on re-vote grounds', async function () {
            const r = await reportFor('VOTE|1|55|1|memo', {});
            expect(r.findings.every(f => f.severity !== 'error')).to.equal(true);
            expect(r.unverified).to.deep.include({
                check: 'VOTE_STATE',
                reason: 'poll state, ballot validity, and vote weight resolve server-side; re-voting is legal (overwrite)',
            });
        });

        it('uses the create-poll note for VOTE v0', async function () {
            const r = await reportFor('VOTE|0|GOV|999999|YES,NO', {});
            expect(r.unverified).to.deep.include({
                check: 'VOTE_CREATE_STATE',
                reason: 'governance-token existence, creator token balance, end-block timing, escrow funding, and binding callback contract state resolve server-side',
            });
        });

        it('keeps the ballot note for VOTE v1', async function () {
            expect(await voteNote(1)).to.deep.equal({
                check: 'VOTE_STATE',
                reason: 'poll state, ballot validity, and vote weight resolve server-side; re-voting is legal (overwrite)',
            });
        });

        it('uses the finalize note for VOTE v2', async function () {
            expect(await voteNote(2)).to.deep.equal({
                check: 'VOTE_FINALIZE_STATE',
                reason: 'poll open state, close eligibility, tally and participation gates, escrow settlement, and binding callback execution resolve server-side',
            });
        });

        it('uses the delegation note for VOTE v3', async function () {
            const r = await reportFor('VOTE|3|GOV||memo', {});
            expect(r.unverified).to.deep.include({
                check: 'VOTE_DELEGATION_STATE',
                reason: 'governance-token existence and the no-self-delegation rule resolve server-side; a valid set or clear replaces the prior standing delegation',
            });
        });

        it('uses the generic note for a future VOTE version', async function () {
            expect(await voteNote(4)).to.deep.equal({
                check: 'VOTE_UNKNOWN_STATE',
                reason: 'no client-side state checks are certified for this action',
            });
        });
    });
});
