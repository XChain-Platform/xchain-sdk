'use strict';

const { expect } = require('chai');
const {
    commandTick,
    limitKeysInListOrder,
    paramsTick,
} = require('../../../../src/protocol/batch_limits/tick_limits.js');

describe('batch limit tick helpers', function () {
    it('reads a SEND tick from the current wire format', function () {
        expect(commandTick(['SEND', '0', 'SAT', '1'].join(String.fromCharCode(124)))).to.equal('SAT');
    });

    it('reads a SEND tick from the legacy wire format', function () {
        expect(commandTick(['SEND', 'SAT', '1'].join(String.fromCharCode(124)))).to.equal('SAT');
    });

    it('reads an ISSUE tick from the current wire format', function () {
        expect(commandTick(['ISSUE', '0', 'JDOG', '1'].join(String.fromCharCode(124)))).to.equal('JDOG');
    });

    it('returns an empty tick for an action alone', function () {
        expect(commandTick(['SEND'].join(String.fromCharCode(124)))).to.equal('');
    });

    it('trims a padded wire tick', function () {
        expect(commandTick(['SEND', '0', '  SAT  ', '1'].join(String.fromCharCode(124)))).to.equal('SAT');
    });

    it('returns an empty tick for null without throwing', function () {
        expect(commandTick(null)).to.equal('');
    });

    it('reads supported tick parameter spellings', function () {
        expect(paramsTick({ TICK: 'UPPER' })).to.equal('UPPER');
        expect(paramsTick({ tick: 'LOWER' })).to.equal('LOWER');
        expect(paramsTick({ Tick: 'TITLE' })).to.equal('TITLE');
    });

    it('normalizes underscores and case in tick parameter keys', function () {
        expect(paramsTick({ T_I_C_K: 'SPACED' })).to.equal('SPACED');
    });

    it('does not treat GIVE_TICK as a tick parameter', function () {
        expect(paramsTick({ GIVE_TICK: 'IGNORED' })).to.equal(undefined);
    });

    it('ignores non-object parameter values', function () {
        expect(paramsTick(null)).to.equal(undefined);
        expect(paramsTick(undefined)).to.equal(undefined);
        expect(paramsTick('SAT')).to.equal(undefined);
    });

    it('returns distinct limit keys in first-appearance order', function () {
        const commands = [
            ['SEND', '0', 'SAT', '1'].join(String.fromCharCode(124)),
            ['ISSUE', '0', 'JDOG', '1'].join(String.fromCharCode(124)),
            ['SEND', '0', 'JDOG', '2'].join(String.fromCharCode(124)),
        ];
        expect(limitKeysInListOrder(commands)).to.deep.equal(['SEND', 'ISSUE']);
    });

    it('returns no limit keys for an empty command list', function () {
        expect(limitKeysInListOrder([])).to.deep.equal([]);
    });
});
