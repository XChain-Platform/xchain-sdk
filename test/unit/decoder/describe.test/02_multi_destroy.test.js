'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const { parse } = require('../../../../src/decoder/parse.js');
const { describe: describeAction } = require('../../../../src/decoder/describe.js');

describe('decoder.describe', function () {
    describe('multi-destroy', function () {
        it('v1 lists every leg and keeps the irreversibility warning', function () {
            const d = describeAction(parse('DESTROY|1|JDOG|5|PEPE|7|bye'));
            expect(d.summary).to.equal('Destroy: 5 JDOG, 7 PEPE');
            expect(d.warnings.join('\n')).to.include('irreversible');
            expect(d.details.find(x => x.label === 'Memo').value).to.equal('bye');
        });

        it('v2 renders the per-leg memo, not a shared one', function () {
            const d = describeAction(parse('DESTROY|2|JDOG|5|one|PEPE|7|two'));
            expect(d.summary).to.equal('Destroy: 5 JDOG, 7 PEPE');
            expect(d.details.filter(x => x.label.trim() === 'Memo').map(x => x.value))
                .to.deep.equal(['one', 'two']);
        });

        it('a non-positive leg amount is flagged', function () {
            const d = describeAction(parse('DESTROY|1|JDOG|5|PEPE|0|bye'));
            expect(d.warnings.join('\n')).to.match(/amounts are not positive/);
        });
    });
});
