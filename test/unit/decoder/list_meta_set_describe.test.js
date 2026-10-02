'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const { decodeListSetMeta } = require('../../../src/decoder/describe/list_share.js');

function detailMap(decoded) {
    return Object.fromEntries(decoded.details.map(({ label, value }) => [label, value]));
}

describe('decoder.describe LIST set metadata', function () {
    it('describes setting the name and description', function () {
        const decoded = decodeListSetMeta({
            LIST_ACTION_INDEX: '41',
            NAME: 'Team wallets',
            DESCRIPTION: 'Current treasury signers',
            MEMO: 'Quarterly update',
        });

        expect(decoded.summary).to.equal('Update metadata on list #41');
        expect(detailMap(decoded)).to.deep.equal({
            'List action index': '41',
            Name: 'Set to: Team wallets',
            Description: 'Set to: Current treasury signers',
            Memo: 'Quarterly update',
        });
        expect(decoded.warnings).to.deep.equal([
            'Updating a shared list name or description charges the shared-list edit fee.',
        ]);
    });

    it('describes an unchanged name and a cleared description', function () {
        const decoded = decodeListSetMeta({
            LIST_ACTION_INDEX: '41',
            NAME: '',
            DESCRIPTION: '-',
            MEMO: '',
        });

        expect(detailMap(decoded)).to.include({
            Name: 'Unchanged',
            Description: 'Cleared',
        });
    });

    it('describes a cleared name and an unchanged description', function () {
        const decoded = decodeListSetMeta({
            LIST_ACTION_INDEX: '41',
            NAME: '-',
            DESCRIPTION: '',
        });

        expect(detailMap(decoded)).to.include({
            Name: 'Cleared',
            Description: 'Unchanged',
        });
    });

    it('warns when both metadata fields are unchanged', function () {
        const decoded = decodeListSetMeta({
            LIST_ACTION_INDEX: '41',
            NAME: '',
            DESCRIPTION: '',
        });

        expect(decoded.warnings).to.include(
            'Name and description are both unchanged. The indexer will refuse this action as NAME (no change).'
        );
    });

    it('warns and uses a question mark when the list action index is empty', function () {
        const decoded = decodeListSetMeta({
            LIST_ACTION_INDEX: '',
            NAME: 'Team wallets',
            DESCRIPTION: '',
        });

        expect(decoded.summary).to.equal('Update metadata on list #?');
        expect(decoded.warnings).to.include('List action index is empty.');
    });
});
