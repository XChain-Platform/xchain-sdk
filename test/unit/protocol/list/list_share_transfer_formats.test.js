/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
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
 * XChain Platform SDK - LIST SHARE and TRANSFER wire formats
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const Actions = require('../../../../src/actions/index.js');
const FormatSelector = require('../../../../src/protocol/format_selector.js');
const Utility = require('../../../../src/utils/utility.js');
const { parse } = require('../../../../src/decoder/parse.js');
const { SDKFormatError } = require('../../../../src/utils/errors.js');

function makeWireActions() {
    const actions = new Actions({ config: {}, util: new Utility() });
    // LIST v2/v3 validation lands separately; this suite isolates wire support.
    actions.validator.validateOrThrow = () => {};
    return actions;
}

describe('LIST SHARE and TRANSFER wire formats', function () {
    for (const testCase of [
        {
            version: 2,
            params: { version: 2, listActionIndex: 17, memo: 'shared' },
            actionString: 'LIST|2|17|shared',
            parsed: { LIST_ACTION_INDEX: '17', MEMO: 'shared' },
        },
        {
            version: 3,
            params: { version: 3, listActionIndex: 29, destination: '^8', memo: 'handoff' },
            actionString: 'LIST|3|29|^8|handoff',
            parsed: { LIST_ACTION_INDEX: '29', DESTINATION: '^8', MEMO: 'handoff' },
        },
    ]) {
        it('serializes and parses LIST v' + testCase.version, function () {
            const built = makeWireActions().createAction({ action: 'LIST', params: testCase.params });
            expect(built.version).to.equal(testCase.version);
            expect(built.actionString).to.equal(testCase.actionString);

            const decoded = parse(built.actionString);
            expect(decoded.ok).to.equal(true);
            expect(decoded.action).to.equal('LIST');
            expect(decoded.version).to.equal(testCase.version);
            for (const [field, value] of Object.entries(testCase.parsed))
                expect(decoded.params[field], field).to.equal(value);
        });
    }

    it('keeps an index and memo on LIST v1 during auto-selection', function () {
        const selected = FormatSelector.select('LIST', {
            LIST_ACTION_INDEX: '17', MEMO: 'ordinary edit'
        });
        expect(selected.version).to.equal(1);
    });

    it('does not auto-select TRANSFER for an index and destination', function () {
        let error;
        try {
            FormatSelector.select('LIST', { LIST_ACTION_INDEX: '17', DESTINATION: '^8' });
        } catch (e) {
            error = e;
        }
        expect(error).to.be.instanceOf(SDKFormatError);
        expect(error.code).to.equal('NO_MATCHING_FORMAT');
    });

    it('leaves other actions auto-selection unchanged', function () {
        expect(FormatSelector.select('ORDER', { ORDER_ACTION_INDEX: '5', MEMO: 'x' }).version).to.equal(1);
        expect(FormatSelector.select('SEND', {
            TICK: 'A', AMOUNT: '1', DESTINATION: 'd'
        }).version).to.equal(0);
    });
});
