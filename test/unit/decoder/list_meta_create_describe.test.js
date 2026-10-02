'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const { decodeListCreateMeta } = require('../../../src/decoder/describe/list_meta_create.js');

function detailMap(decoded) {
    return Object.fromEntries(decoded.details.map(({ label, value }) => [label, value]));
}

describe('decoder.describe LIST create with metadata', function () {
    it('describes a named token list', function () {
        const decoded = decodeListCreateMeta({
            TYPE: '1',
            NAME: 'Official tokens',
            DESCRIPTION: 'Tokens issued by our team',
            MEMO: 'initial list',
            ITEM: ['JDOG', 'BRRR'],
        }, ' on Dogecoin');

        expect(decoded.summary).to.equal('Create token list "Official tokens" of 2 items on Dogecoin');
        expect(detailMap(decoded)).to.deep.equal({
            Type: 'Token',
            Name: 'Official tokens',
            Description: 'Tokens issued by our team',
            Items: '2',
            Sample: 'JDOG, BRRR',
            Memo: 'initial list',
        });
        expect(decoded.warnings).to.deep.equal([]);
    });

    it('describes an address list with only a description', function () {
        const decoded = decodeListCreateMeta({
            TYPE: '2',
            NAME: '',
            DESCRIPTION: 'Treasury recipients',
            MEMO: '',
            ITEM: ['DOne', 'DTwo'],
        });

        expect(decoded.summary).to.equal('Create address list of 2 items');
        expect(detailMap(decoded)).to.deep.equal({
            Type: 'Address',
            Description: 'Treasury recipients',
            Items: '2',
            Sample: 'DOne, DTwo',
        });
        expect(decoded.warnings).to.deep.equal([]);
    });
});

describe('decoder.describe LIST metadata create kinds', function () {
    it('describes a union list and samples member list indexes', function () {
        const decoded = decodeListCreateMeta({
            TYPE: '3',
            NAME: 'Combined policy',
            DESCRIPTION: '',
            MEMO: 'combined',
            ITEM: ['41', '52', '63'],
        });

        expect(decoded.summary).to.equal('Create union list "Combined policy" of 3 member lists');
        expect(detailMap(decoded)).to.deep.equal({
            Type: 'Union',
            Name: 'Combined policy',
            Items: '3',
            'Member list indexes': '41, 52, 63',
            Memo: 'combined',
        });
        expect(decoded.warnings).to.deep.equal([]);
    });

    it('matches the format 0 create wording when neither metadata field is set', function () {
        const decoded = decodeListCreateMeta({
            TYPE: '1',
            NAME: '',
            DESCRIPTION: '',
            MEMO: '',
            ITEM: ['JDOG'],
        });

        expect(decoded).to.deep.equal({
            summary: 'Create token list of 1 item',
            details: [
                { label: 'Type', value: 'Token' },
                { label: 'Items', value: '1' },
                { label: 'Sample', value: 'JDOG' },
            ],
            warnings: [],
        });
    });
});

describe('decoder.describe LIST metadata create warnings', function () {
    it('warns when the list has no items', function () {
        const decoded = decodeListCreateMeta({
            TYPE: '2',
            NAME: 'Empty list',
            DESCRIPTION: '',
            MEMO: '',
            ITEM: [],
        });

        expect(decoded.summary).to.equal('Create address list "Empty list" of ? items');
        expect(detailMap(decoded).Items).to.equal('0');
        expect(decoded.warnings).to.deep.equal(['List has no items.']);
    });

    it('warns that a name clear sentinel is invalid in a create', function () {
        const decoded = decodeListCreateMeta({
            TYPE: '1',
            NAME: '-',
            DESCRIPTION: '',
            MEMO: '',
            ITEM: ['JDOG'],
        });

        expect(decoded.warnings).to.deep.equal([
            'Name cannot be cleared when creating a list. The indexer will refuse it as NAME (format).',
        ]);
    });

    it('warns that a description clear sentinel is invalid in a create', function () {
        const decoded = decodeListCreateMeta({
            TYPE: '2',
            NAME: '',
            DESCRIPTION: '-',
            MEMO: '',
            ITEM: ['DOne'],
        });

        expect(decoded.warnings).to.deep.equal([
            'Description cannot be cleared when creating a list. The indexer will refuse it as DESCRIPTION (format).',
        ]);
    });
});
