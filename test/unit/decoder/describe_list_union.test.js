'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const { parse } = require('../../../src/decoder/parse.js');
const { describe: describeAction } = require('../../../src/decoder/describe.js');

function detailMap(decoded) {
    return Object.fromEntries(decoded.details.map(({ label, value }) => [label, value]));
}

describe('decoder.describe LIST union create', function () {
    it('describes member list indexes and appends the chain suffix', function () {
        const chainRegistry = { get: () => ({ displayName: 'Dogecoin' }) };
        const decoded = describeAction(
            parse('LIST|0|3|combined policy|41|52'),
            { chainId: 'doge', chainRegistry }
        );

        expect(decoded.summary).to.equal('Create union list of 2 member lists on Dogecoin');
        expect(detailMap(decoded)).to.deep.equal({
            Type: 'Union',
            Items: '2',
            'Member list indexes': '41, 52',
            Memo: 'combined policy',
        });
        expect(decoded.warnings).to.deep.equal([]);
    });

    it('uses an unknown count and keeps the no-items warning when empty', function () {
        const decoded = describeAction(parse('LIST|0|3|'));

        expect(decoded.summary).to.equal('Create union list of ? member lists');
        expect(decoded.details).to.deep.equal([
            { label: 'Type', value: 'Union' },
            { label: 'Items', value: '0' },
        ]);
        expect(decoded.warnings).to.deep.equal(['List has no items.']);
    });

    it('keeps the empty-type and no-items warnings', function () {
        const decoded = describeAction(parse('LIST|0||'));

        expect(decoded.summary).to.equal('Create item list of ? items');
        expect(decoded.warnings).to.deep.equal([
            'List type is empty. Specify a token list or an address list.',
            'List has no items.',
        ]);
    });

    it('leaves TYPE 2 create unchanged', function () {
        const decoded = describeAction(parse('LIST|0|2|trusted recipients|DOne|DTwo'));

        expect(decoded).to.deep.equal({
            summary: 'Create address list of 2 items',
            details: [
                { label: 'Type', value: 'Address' },
                { label: 'Items', value: '2' },
                { label: 'Sample', value: 'DOne, DTwo' },
                { label: 'Memo', value: 'trusted recipients' },
            ],
            warnings: [],
        });
    });

    it('leaves version 1 edit unchanged', function () {
        const decoded = describeAction(parse('LIST|1|1|1234|adding two|AAA|BBB'));

        expect(decoded).to.deep.equal({
            summary: 'Add 2 items to list #1234',
            details: [
                { label: 'Edit', value: 'Add' },
                { label: 'Parent list action index', value: '1234' },
                { label: 'Items', value: '2' },
                { label: 'Sample', value: 'AAA, BBB' },
                { label: 'Memo', value: 'adding two' },
            ],
            warnings: [],
        });
    });
});
