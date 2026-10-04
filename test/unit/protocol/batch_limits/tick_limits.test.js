'use strict';

const { expect } = require('chai');
const {
    commandTick,
    limitKeysInListOrder,
    paramsTick,
} = require('../../../../src/protocol/batch_limits/tick_limits.js');

describe('batch limit tick helpers', function () {
    it('reads ticks from current and legacy raw commands', function () {
        expect(commandTick(['SEND', '0', 'SAT', '1'].join(String.fromCharCode(124)))).to.equal('SAT');
        expect(commandTick(['SEND', 'SAT', '1'].join(String.fromCharCode(124)))).to.equal('SAT');
        expect(commandTick(['ISSUE', '0', 'JDOG', '1'].join(String.fromCharCode(124)))).to.equal('JDOG');
        expect(commandTick(['SEND'].join(String.fromCharCode(124)))).to.equal('');
        expect(commandTick(['SEND', '0', '  SAT  ', '1'].join(String.fromCharCode(124)))).to.equal('SAT');
        expect(commandTick(null)).to.equal('');
    });

    it('reads only normalized tick parameter keys from objects', function () {
        expect(paramsTick({ TICK: 'UPPER' })).to.equal('UPPER');
        expect(paramsTick({ tick: 'LOWER' })).to.equal('LOWER');
        expect(paramsTick({ Tick: 'TITLE' })).to.equal('TITLE');
        expect(paramsTick({ T_I_C_K: 'SPACED' })).to.equal('SPACED');
        expect(paramsTick({ GIVE_TICK: 'IGNORED' })).to.equal(undefined);
        for (const value of [null, undefined, 'SAT']) expect(paramsTick(value)).to.equal(undefined);
    });

    it('returns distinct limit keys in first-appearance order', function () {
        const commands = [
            ['SEND', '0', 'SAT', '1'].join(String.fromCharCode(124)),
            ['ISSUE', '0', 'JDOG', '1'].join(String.fromCharCode(124)),
            ['SEND', '0', 'JDOG', '2'].join(String.fromCharCode(124)),
        ];
        expect(limitKeysInListOrder(commands)).to.deep.equal(['SEND', 'ISSUE']);
        expect(limitKeysInListOrder([])).to.deep.equal([]);
    });
});
