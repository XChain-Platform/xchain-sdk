'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const { parse } = require('../../../../src/decoder/parse.js');
const { describe: describeAction } = require('../../../../src/decoder/describe.js');

describe('decoder.describe', function () {
    describe('ADDRESS', function () {
        it('v0 names the options the action actually sets', function () {
            const d = describeAction(parse('ADDRESS|0|1||2|'));
            expect(d.summary).to.include('fees destroyed');
            expect(d.summary).to.include('anyone may open a dispenser');
            expect(d.warnings.join('\n')).to.include('burned permanently');
        });

        it('v0 with every option blank says so instead of implying a change', function () {
            const d = describeAction(parse('ADDRESS|0||||'));
            expect(d.summary).to.include('no options changed');
            expect(d.warnings.join('\n')).to.include('sets no address options');
        });

        it('v0 flags a fee preference the indexer will reject', function () {
            const d = describeAction(parse('ADDRESS|0|3|||'));
            expect(d.warnings.join('\n')).to.match(/must be 0, 1 or 2/);
        });

        it('v1 bind states the symmetric transfer gate', function () {
            const d = describeAction(parse('ADDRESS|1|42|transfer|10|0'));
            expect(d.summary).to.equal('Bind this address to controller #42 (transfer)');
            expect(d.warnings.join('\n')).to.include('BOTH sends from and sends to');
        });

        it('v1 unbind reads as an unbind, not a bind', function () {
            const d = describeAction(parse('ADDRESS|1|42|transfer|10|1'));
            expect(d.summary).to.equal('Unbind controller from this address (transfer)');
            expect(d.warnings.join('\n')).to.include('after the cooldown elapses');
        });
    });
});
