/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * GENERATED from PIN_ONLY_VERSIONS
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
 * XChain Platform SDK - Format Selector pin-only versions
 *
 * Pin-only versions are built for an explicit VERSION and never auto-selected
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const FormatSelector = require('../../../../src/protocol/format_selector.js');
const { PIN_ONLY_VERSIONS } = require('../../../../src/protocol/format_selector/field_names.js');

describe('FormatSelector pin-only versions', () => {
    it('pins LIST versions without changing TYPE and ITEM selection', () => {
        expect(PIN_ONLY_VERSIONS.LIST).to.deep.equal([2, 3, 4, 5]);
        expect(Object.isFrozen(PIN_ONLY_VERSIONS.LIST)).to.equal(true);

        expect(FormatSelector.select('LIST', { TYPE: '1', ITEM: ['A'] }).version).to.equal(0);
    });

    it('never auto-selects a pin-only LIST version', () => {
        const fields = { LIST_ACTION_INDEX: '5', MEMO: 'x' };
        expect(FormatSelector.estimateLength('LIST', 2, fields))
            .to.be.lessThan(FormatSelector.estimateLength('LIST', 1, fields));

        const selected = FormatSelector.select('LIST', fields);
        expect(selected.version).to.equal(1);
    });

    it('builds both pin-only versions when the caller names them', () => {
        expect(FormatSelector.select('LIST', { LIST_ACTION_INDEX: '5' }, 2).version).to.equal(2);
        expect(FormatSelector.select('LIST', {
            LIST_ACTION_INDEX: '5', DESTINATION: 'd'
        }, 3).version).to.equal(3);
    });

    it('leaves ORDER and SEND auto-selection unchanged', () => {
        expect(FormatSelector.select('ORDER', { ORDER_ACTION_INDEX: '5', MEMO: 'x' }).version).to.equal(1);
        expect(FormatSelector.select('SEND', { TICK: 'A', AMOUNT: '1', DESTINATION: 'd' }).version).to.equal(0);
    });
});
