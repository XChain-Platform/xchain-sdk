'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const {
    ASPECT_NOTES,
    LIST_SET_META_NOTE,
    checkMisc,
} = require('../../../../src/preflight/checks/misc.js');

describe('pre-flight LIST SET META fee note', function () {
    async function collect(parsed) {
        const calls = [];

        await checkMisc({
            parsed,
            addUnverified: (...args) => calls.push(args),
        });

        return calls;
    }

    it('files the shared-list edit fee note after LIST state for format 5', async function () {
        const calls = await collect({ action: 'LIST', version: 5 });

        expect(calls).to.deep.equal([
            ['LIST_STATE', ASPECT_NOTES.LIST],
            ['LIST_SET_META_FEE', LIST_SET_META_NOTE],
        ]);
        expect(LIST_SET_META_NOTE).to.include('LIST_SHARED_EDIT_BASE');
        expect(LIST_SET_META_NOTE).to.include('shared');
    });

    for (const version of [0, 1, 2, 3, 4, undefined]) {
        it(`files only LIST state for version ${String(version)}`, async function () {
            const parsed = { action: 'LIST' };
            if (version !== undefined) parsed.version = version;

            expect(await collect(parsed)).to.deep.equal([
                ['LIST_STATE', ASPECT_NOTES.LIST],
            ]);
        });
    }

    it('does not file the fee note for another action at version 5', async function () {
        expect(await collect({ action: 'FILE', version: 5 })).to.deep.equal([
            ['FILE_STATE', ASPECT_NOTES.FILE],
        ]);
    });
});
