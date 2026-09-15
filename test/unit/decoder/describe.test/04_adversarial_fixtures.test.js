'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const { parse } = require('../../../../src/decoder/parse.js');
const { describe: describeAction } = require('../../../../src/decoder/describe.js');

describe('decoder.describe', function () {
    describe('§3.5 adversarial fixtures', function () {
        it('bidi override in MEMO is neutralized and flagged', function () {
            const d = describeAction(parse('SEND|0|JDOG|1|addr|pay ‮evil‬ now'));
            expect(JSON.stringify(d.details)).to.not.include('‮');
            expect(d.warnings.some(w => /direction-control/.test(w))).to.equal(true);
        });

        it('zero-width in TICK-adjacent text is stripped and flagged', function () {
            const d = describeAction({ action: 'SEND', params: { TICK: 'JD​OG', AMOUNT: '1', DESTINATION: 'a' } });
            expect(d.details.find(x => x.label === 'Token').value).to.equal('JDOG');
            expect(d.warnings.some(w => /zero-width/.test(w))).to.equal(true);
        });

        it('exponential AMOUNT is flagged, never prettified', function () {
            const d = describeAction({ action: 'SEND', params: { TICK: 'JDOG', AMOUNT: '1e21', DESTINATION: 'a' } });
            expect(d.details.find(x => x.label === 'Amount').value).to.equal('1e21');
            expect(d.warnings.some(w => /exponential/.test(w))).to.equal(true);
        });

        it('multi-leg amounts are formatted per leg, no false junk flag', function () {
            const d = describeAction(parse('SEND|1|JDOG|1|a|2|b|m'));
            expect(d.warnings.some(w => /not a plain decimal/.test(w))).to.equal(false);
        });

        it('describe output is deduplicated and text-only', function () {
            const d = describeAction(parse('SEND|0|JDOG|1|addr|<b>x</b>'));
            // No HTML interpretation is decoder business; value passes as text.
            expect(d.details.find(x => x.label === 'Memo').value).to.equal('<b>x</b>');
        });
    });
});
