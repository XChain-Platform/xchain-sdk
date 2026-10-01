/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Platform SDK - LIST share, transfer, and union validation
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const Actions = require('../../../../src/actions/index.js');
const Utility = require('../../../../src/utils/utility.js');
const { SDKValidationError } = require('../../../../src/utils/errors.js');

const ADDRESS = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';

function create(params) {
    const actions = new Actions({ config: {}, util: new Utility() });
    return actions.createAction({ action: 'LIST', params });
}

function refused(params) {
    try {
        create(params);
    } catch (error) {
        expect(error).to.be.instanceOf(SDKValidationError);
        return error.details.errors;
    }
    throw new Error('expected LIST action to be refused');
}

function hasField(errors, field) {
    return errors.some(error => error.details.field === field);
}

describe('LIST share, transfer, and union validation through createAction', function () {
    it('accepts VERSION 2 with a positive LIST_ACTION_INDEX', function () {
        const action = create({ version: 2, listActionIndex: 17, memo: 'shared' });
        expect(action.version).to.equal(2);
        expect(action.actionString).to.equal('LIST|2|17|shared');
    });

    it('requires a positive-integer LIST_ACTION_INDEX for VERSION 2', function () {
        expect(hasField(refused({ version: 2 }), 'LIST_ACTION_INDEX')).to.equal(true);
        for (const listActionIndex of [0, -1, 1.5, 'nope'])
            expect(hasField(refused({ version: 2, listActionIndex }), 'LIST_ACTION_INDEX')).to.equal(true);
    });

    for (const [field, params] of [
        ['EDIT', { version: 2, listActionIndex: 17, edit: 1 }],
        ['TYPE', { version: 2, listActionIndex: 17, type: 1 }],
        ['DESTINATION', { version: 2, listActionIndex: 17, destination: ADDRESS }],
        ['ITEM', { version: 2, listActionIndex: 17, item: 'TOKEN' }],
    ]) {
        it('refuses ' + field + ' on VERSION 2', function () {
            expect(hasField(refused(params), field)).to.equal(true);
        });
    }

    it('accepts VERSION 3 with a full address or numeric address reference', function () {
        expect(create({ version: 3, listActionIndex: 29, destination: ADDRESS }).actionString)
            .to.equal('LIST|3|29|' + ADDRESS);
        expect(create({ version: 3, listActionIndex: 29, destination: '^8', memo: 'handoff' }).actionString)
            .to.equal('LIST|3|29|^8|handoff');
    });

    it('requires LIST_ACTION_INDEX and DESTINATION for VERSION 3', function () {
        expect(hasField(refused({ version: 3, destination: ADDRESS }), 'LIST_ACTION_INDEX')).to.equal(true);
        expect(hasField(refused({ version: 3, listActionIndex: 29 }), 'DESTINATION')).to.equal(true);
    });

    it('refuses malformed VERSION 3 destinations', function () {
        expect(hasField(refused({ version: 3, listActionIndex: 29, destination: 'bad' }), 'DESTINATION')).to.equal(true);
        expect(hasField(refused({ version: 3, listActionIndex: 29, destination: '^bad' }), 'DESTINATION')).to.equal(true);
    });

    it('refuses ITEM on VERSION 3', function () {
        expect(hasField(refused({ version: 3, listActionIndex: 29, destination: ADDRESS, item: 'TOKEN' }), 'ITEM')).to.equal(true);
    });

    it('refuses DESTINATION without VERSION 3 with the transfer diagnostic', function () {
        const errors = refused({ type: 1, item: 'TOKEN', destination: ADDRESS });
        expect(errors.some(error => error.message === 'LIST TRANSFER must be requested with VERSION 3')).to.equal(true);
    });

    it('accepts TYPE 3 creates with one through sixteen unique positive indexes', function () {
        expect(create({ type: 3, item: '1' }).actionString).to.equal('LIST|0|3||1');
        const item = Array.from({ length: 16 }, (_, index) => String(index + 1));
        expect(create({ type: 3, item }).actionString).to.equal('LIST|0|3||' + item.join('|'));
    });

    it('requires one through sixteen ITEM values for TYPE 3 creates', function () {
        expect(hasField(refused({ type: 3 }), 'ITEM')).to.equal(true);
        expect(hasField(refused({ type: 3, item: [] }), 'ITEM')).to.equal(true);
        const item = Array.from({ length: 17 }, (_, index) => String(index + 1));
        expect(hasField(refused({ type: 3, item }), 'ITEM')).to.equal(true);
    });

    it('refuses non-positive, non-integer, referenced, and duplicate TYPE 3 members', function () {
        for (const item of ['0', '-1', '1.5', '^7', 'TOKEN'])
            expect(hasField(refused({ type: 3, item }), 'ITEM')).to.equal(true);
        expect(hasField(refused({ type: 3, item: ['7', '8', '7'] }), 'ITEM')).to.equal(true);
    });

    it('preserves VERSION 1 edit validation and serialization', function () {
        const action = create({ version: 1, edit: 1, listActionIndex: 5, item: 'TOKEN' });
        expect(action.actionString).to.equal('LIST|1|1|5||TOKEN');
    });

    it('preserves TYPE 2 create validation and serialization', function () {
        const action = create({ type: 2, item: ADDRESS });
        expect(action.actionString).to.equal('LIST|0|2||' + ADDRESS);
    });
});
