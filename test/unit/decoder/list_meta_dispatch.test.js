'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const { decodeList } = require('../../../src/decoder/describe/distributions.js');
const { decodeListCreateMeta } = require('../../../src/decoder/describe/list_meta_create.js');
const { decodeListSetMeta } = require('../../../src/decoder/describe/list_share.js');

describe('decoder.describe LIST metadata dispatch', function () {
    const create = {
        VERSION: '4',
        TYPE: '1',
        NAME: 'Team tokens',
        DESCRIPTION: 'Tokens issued by the team',
        MEMO: 'initial list',
        ITEM: ['JDOG', 'BRRR'],
    };

    it('dispatches version 4 to the metadata create describer', function () {
        expect(decodeList(create, '')).to.deep.equal(decodeListCreateMeta(create, ''));
    });

    it('passes the chain suffix through for version 4', function () {
        expect(decodeList(create, ' on Dogecoin')).to.deep.equal(
            decodeListCreateMeta(create, ' on Dogecoin')
        );
    });

    it('dispatches version 5 to the metadata update describer', function () {
        const update = {
            VERSION: '5',
            LIST_ACTION_INDEX: '41',
            NAME: 'Team wallets',
            DESCRIPTION: 'Current treasury signers',
            MEMO: 'Quarterly update',
        };

        expect(decodeList(update, '')).to.deep.equal(decodeListSetMeta(update));
    });
});

describe('decoder.describe LIST legacy dispatch', function () {
    it('keeps version 0 create summaries unchanged', function () {
        const decoded = decodeList({
            VERSION: '0',
            TYPE: '2',
            MEMO: '',
            ITEM: ['DOne', 'DTwo'],
        }, '');

        expect(decoded.summary).to.equal('Create address list of 2 items');
    });

    it('keeps version 1 edit summaries unchanged', function () {
        const decoded = decodeList({
            VERSION: '1',
            EDIT: '1',
            LIST_ACTION_INDEX: '41',
            MEMO: 'append',
            ITEM: ['DThree'],
        }, '');

        expect(decoded.summary).to.equal('Add 1 item to list #41');
    });

    it('keeps version 2 share summaries unchanged', function () {
        const decoded = decodeList({
            VERSION: '2',
            LIST_ACTION_INDEX: '41',
            MEMO: 'trusted recipients',
        }, '');

        expect(decoded.summary).to.equal('Share list #41 on every chain');
    });

    it('keeps version 3 transfer summaries unchanged', function () {
        const decoded = decodeList({
            VERSION: '3',
            LIST_ACTION_INDEX: '41',
            DESTINATION: 'DNewOwner',
            MEMO: 'handoff',
        }, '');

        expect(decoded.summary).to.equal('Transfer list #41 to DNewOwner');
    });
});
