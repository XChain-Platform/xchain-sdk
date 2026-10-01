// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const { expect } = require('chai');
const { actionRecord, readParentListType } = require('../../../../src/utils/list/parent_list_type.js');

describe('parent list type', function () {
    it('reads lower-case type from a wrapped action record', async function () {
        let calls = 0;
        const explorer = {
            getAction: async (index) => {
                calls += 1;
                expect(index).to.equal(7);
                return { data: [{ type: 1 }] };
            }
        };

        expect(await readParentListType(explorer, 7, (promise) => promise)).to.equal(1);
        expect(calls).to.equal(1);
    });

    it('reads upper-case TYPE from a direct action record', async function () {
        const explorer = { getAction: async () => ({ TYPE: '2' }) };

        expect(await readParentListType(explorer, 8, (promise) => promise)).to.equal('2');
    });

    it('returns null for a null answer or a throwing read', async function () {
        const nullExplorer = { getAction: async () => null };
        const throwingExplorer = { getAction: async () => { throw new Error('unavailable'); } };

        expect(await readParentListType(nullExplorer, 9, (promise) => promise)).to.equal(null);
        expect(await readParentListType(throwingExplorer, 10, (promise) => promise)).to.equal(null);
    });

    it('returns null when the cap rejects', async function () {
        const explorer = { getAction: async () => ({ type: 2 }) };
        const reject = () => Promise.reject(new Error('capped'));

        expect(await readParentListType(explorer, 7, reject)).to.equal(null);
    });

    it('does not read without an index or usable explorer', async function () {
        let calls = 0;
        const explorer = { getAction: async () => { calls += 1; return { type: 2 }; } };
        const cap = (promise) => promise;

        expect(await readParentListType(explorer, null, cap)).to.equal(null);
        expect(await readParentListType(explorer, undefined, cap)).to.equal(null);
        expect(await readParentListType(null, 7, cap)).to.equal(null);
        expect(await readParentListType({}, 7, cap)).to.equal(null);
        expect(calls).to.equal(0);
    });

    it('normalizes wrapped records', function () {
        expect(actionRecord({ data: [{ type: 3 }] })).to.deep.equal({ type: 3 });
    });
});
