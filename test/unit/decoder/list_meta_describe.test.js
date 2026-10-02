'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const { describe: describeAction } = require('../../../src/decoder/describe.js');

function describeList(version, params, ctx) {
    return describeAction({ action: 'LIST', version, params }, ctx);
}

function detailMap(decoded) {
    return Object.fromEntries(decoded.details.map(({ label, value }) => [label, value]));
}

describe('decoder.describe LIST format 4', function () {
    it('describes a named token list through the public describer', function () {
        const chainRegistry = { get: () => ({ displayName: 'Dogecoin' }) };
        const decoded = describeList(4, {
            TYPE: '1',
            NAME: 'Official tokens',
            DESCRIPTION: 'Tokens issued by our team',
            MEMO: 'initial list',
            ITEM: ['JDOG', 'BRRR'],
        }, { chainId: 'dogecoin-mainnet', chainRegistry });

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

    it('renders optional metadata without changing the unnamed create wording', function () {
        const descriptionOnly = describeList(4, {
            TYPE: '2',
            NAME: '',
            DESCRIPTION: 'Treasury recipients',
            MEMO: '',
            ITEM: ['DOne', 'DTwo'],
        });

        expect(descriptionOnly.summary).to.equal('Create address list of 2 items');
        expect(detailMap(descriptionOnly)).to.deep.equal({
            Type: 'Address',
            Description: 'Treasury recipients',
            Items: '2',
            Sample: 'DOne, DTwo',
        });
    });
});

describe('decoder.describe LIST format 5', function () {
    it('describes setting each metadata field', function () {
        const decoded = describeList(5, {
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

    it('distinguishes unchanged and cleared values per field', function () {
        const clearDescription = describeList(5, {
            LIST_ACTION_INDEX: '41',
            NAME: '',
            DESCRIPTION: '-',
        });
        expect(detailMap(clearDescription)).to.include({
            Name: 'Unchanged',
            Description: 'Cleared',
        });

        const clearName = describeList(5, {
            LIST_ACTION_INDEX: '41',
            NAME: '-',
            DESCRIPTION: '',
        });
        expect(detailMap(clearName)).to.include({
            Name: 'Cleared',
            Description: 'Unchanged',
        });
    });

    it('warns when both fields are unchanged', function () {
        const decoded = describeList(5, {
            LIST_ACTION_INDEX: '41',
            NAME: '',
            DESCRIPTION: '',
        });

        expect(detailMap(decoded)).to.include({
            Name: 'Unchanged',
            Description: 'Unchanged',
        });
        expect(decoded.warnings).to.include(
            'Name and description are both unchanged. The indexer will refuse this action as NAME (no change).'
        );
    });
});

describe('decoder.describe LIST metadata hardening', function () {
    it('neutralizes hidden text in format 4 summaries and details', function () {
        const decoded = describeList(4, {
            TYPE: '1',
            NAME: 'Official\u202Etokens',
            DESCRIPTION: 'Treasury\u200B recipients',
            MEMO: '',
            ITEM: ['JDOG'],
        });

        expect(decoded.summary).to.include('Official␦tokens');
        expect(decoded.summary).to.not.include('\u202E');
        expect(detailMap(decoded)).to.include({
            Name: 'Official␦tokens',
            Description: 'Treasury recipients',
        });
        expect(decoded.warnings).to.include(
            'Text contains hidden direction-control characters (shown as ␦). Treat this transaction with suspicion.'
        );
        expect(decoded.warnings).to.include(
            'Text contained invisible zero-width characters; they were removed for display.'
        );
    });

    it('neutralizes hidden text in format 5 set values', function () {
        const decoded = describeList(5, {
            LIST_ACTION_INDEX: '41',
            NAME: 'Team\u200B wallets',
            DESCRIPTION: 'Current\u202Esigners',
        });

        expect(detailMap(decoded)).to.include({
            Name: 'Set to: Team wallets',
            Description: 'Set to: Current␦signers',
        });
        expect(decoded.warnings).to.have.length(3);
    });
});
