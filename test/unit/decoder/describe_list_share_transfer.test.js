'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const { parse } = require('../../../src/decoder/parse.js');
const { describe: describeAction } = require('../../../src/decoder/describe.js');

function describeList(wire) {
    return describeAction(parse(wire));
}

function detailMap(decoded) {
    return Object.fromEntries(decoded.details.map(({ label, value }) => [label, value]));
}

describe('decoder.describe LIST share and transfer', function () {
    it('describes permanent cross-chain sharing and its fee', function () {
        const decoded = describeList('LIST|2|41|trusted recipients');

        expect(decoded.summary).to.equal('Share list #41 on every chain');
        expect(detailMap(decoded)).to.deep.equal({
            'List action index': '41',
            Memo: 'trusted recipients',
        });
        expect(decoded.warnings).to.deep.equal([
            'Sharing is permanent. There is no unshare.',
            'Sharing charges the LIST_SHARE fee.',
        ]);
    });

    it('warns when a share has no list action index', function () {
        const decoded = describeList('LIST|2||memo');

        expect(decoded.summary).to.equal('Share list #? on every chain');
        expect(decoded.warnings).to.include('List action index is empty.');
    });
});

describe('decoder.describe LIST transfer', function () {
    it('describes a transfer to a full address and its consequences', function () {
        const decoded = describeList('LIST|3|41|DNewOwner|handoff');

        expect(decoded.summary).to.equal('Transfer list #41 to DNewOwner');
        expect(detailMap(decoded)).to.deep.equal({
            'List action index': '41',
            Destination: 'DNewOwner',
            Memo: 'handoff',
        });
        expect(decoded.warnings).to.deep.equal([
            'This transfer cannot be undone.',
            'The new owner alone can edit, share or transfer the list.',
        ]);
    });

    it('renders a short destination as an address id', function () {
        const decoded = describeList('LIST|3|41|^902|');

        expect(decoded.summary).to.equal('Transfer list #41 to address id 902');
        expect(detailMap(decoded).Destination).to.equal('address id 902');
    });

    it('warns when a transfer has no list index or destination', function () {
        const decoded = describeList('LIST|3|||memo');

        expect(decoded.summary).to.equal('Transfer list #? to ?');
        expect(decoded.warnings).to.include.members([
            'List action index is empty.',
            'Destination is empty.',
        ]);
    });
});

describe('decoder.describe LIST create and edit compatibility', function () {
    it('describes a type 3 create as a union of member lists', function () {
        const decoded = describeList('LIST|0|3|combined|11|22|33');

        expect(decoded.summary).to.equal('Create union list of 3 member lists');
        expect(detailMap(decoded)).to.deep.equal({
            Type: 'Union',
            Items: '3',
            'Member list indexes': '11, 22, 33',
            Memo: 'combined',
        });
    });

    it('leaves version 0 create descriptions unchanged', function () {
        const decoded = describeList('LIST|0|2||DOne|DTwo');

        expect(decoded.summary).to.equal('Create address list of 2 items');
        expect(detailMap(decoded)).to.deep.equal({
            Type: 'Address',
            Items: '2',
            Sample: 'DOne, DTwo',
        });
        expect(decoded.warnings).to.deep.equal([]);
    });

    it('leaves version 1 edit descriptions unchanged', function () {
        const decoded = describeList('LIST|1|1|41|append|DThree');

        expect(decoded.summary).to.equal('Add 1 item to list #41');
        expect(detailMap(decoded)).to.deep.equal({
            Edit: 'Add',
            'Parent list action index': '41',
            Items: '1',
            Sample: 'DThree',
            Memo: 'append',
        });
        expect(decoded.warnings).to.deep.equal([]);
    });
});
