'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const { ASPECT_NOTES, checkMisc } = require('../../../../src/preflight/checks/misc.js');

describe('pre-flight LIST refusal note', function () {
    it('names the whole-action server-side refusals and per-item handling', function () {
        const note = ASPECT_NOTES.LIST;

        for (const term of ['SHARE', 'TRANSFER', 'owner', 'union', '10,000', 'per-item']) {
            expect(note).to.include(term);
        }
    });

    it('files the LIST note as unverified LIST state', async function () {
        const calls = [];

        await checkMisc({
            parsed: { action: 'LIST' },
            addUnverified: (...args) => calls.push(args),
        });

        expect(calls).to.deep.equal([['LIST_STATE', ASPECT_NOTES.LIST]]);
    });
});
