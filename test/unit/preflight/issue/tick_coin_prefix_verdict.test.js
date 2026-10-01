'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const {
    TICK_RESERVED_VERDICT,
    tickCoinPrefixVerdict,
} = require('../../../../src/preflight/checks/issue/tick_coin_prefix.js');

describe('ISSUE coin-qualified tick verdict', function () {
    const verdict = (tick, active = true, token = null) =>
        tickCoinPrefixVerdict({ tick, active, token });

    it('refuses fresh coin-qualified ticks with an upper-cased root', function () {
        expect(TICK_RESERVED_VERDICT).to.equal('invalid: TICK (reserved)');
        expect(verdict('BTC:FOO')).to.deep.equal({
            refuse: TICK_RESERVED_VERDICT,
            root: 'BTC',
        });
        expect(verdict('eth:FOO')).to.deep.equal({
            refuse: TICK_RESERVED_VERDICT,
            root: 'ETH',
        });
    });

    it('does nothing while LIST_TICK_COIN is inactive', function () {
        expect(verdict('BTC:FOO', false)).to.equal(null);
        expect(verdict('BTC:FOO', 1)).to.equal(null);
    });

    it('does not refuse an existing token', function () {
        expect(verdict('BTC:OLD', true, { tick: 'BTC:OLD' })).to.equal(null);
    });

    it('ignores non-qualifying, caret, dotted, and plain ticks', function () {
        for (const tick of ['FOO:BTC', '^12', 'BTC:FOO.BAR', 'PEPE'])
            expect(verdict(tick), tick).to.equal(null);
    });

    it('ignores non-string ticks', function () {
        for (const tick of [null, undefined, 42, {}, []])
            expect(verdict(tick), String(tick)).to.equal(null);
    });

    it('declares an unavailable token lookup', function () {
        expect(tickCoinPrefixVerdict({ tick: 'BTC:FOO', active: true, token: undefined })).to.deep.equal({
            unverified: 'token lookup unavailable',
        });
    });
});
