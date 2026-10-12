'use strict';

const { expect } = require('chai');
const {
    TOTAL_SCALE,
    toScaledUnits,
    fromScaledUnits,
    getCoinLabel,
    collectLockFlags,
} = require('../../../../src/decoder/describe/value_format.js');

describe('decoder.describe.value_format scaled units', function () {
    it('fixes the scale at 18 decimal places', function () {
        expect(TOTAL_SCALE).to.equal(1000000000000000000n);
    });

    it('scales plain decimals to exact BigInt units', function () {
        expect(toScaledUnits('1')).to.equal(1000000000000000000n);
        expect(toScaledUnits('1.5')).to.equal(1500000000000000000n);
        expect(toScaledUnits('0.000000000000000001')).to.equal(1n);
    });

    it('trims whitespace and reads a number through its string', function () {
        expect(toScaledUnits(' 2 ')).to.equal(2000000000000000000n);
        expect(toScaledUnits(3)).to.equal(3000000000000000000n);
    });

    it('returns null for anything that is not a plain unsigned decimal', function () {
        for (const bad of ['0.0000000000000000001', '-1', '1e3', '.5', '', null, undefined]) {
            expect(toScaledUnits(bad), String(bad)).to.equal(null);
        }
    });

    it('formats scaled units back to a trimmed decimal string', function () {
        expect(fromScaledUnits(1500000000000000000n)).to.equal('1.5');
        expect(fromScaledUnits(1000000000000000000n)).to.equal('1');
        expect(fromScaledUnits(1n)).to.equal('0.000000000000000001');
        expect(fromScaledUnits(0n)).to.equal('0');
    });

    it('round-trips a decimal string', function () {
        expect(fromScaledUnits(toScaledUnits('12.34'))).to.equal('12.34');
    });

    it('labels a native coin and returns an empty string for no coin', function () {
        expect(getCoinLabel('BTC')).to.equal('BTC (native coin)');
        for (const none of ['', null, undefined]) {
            expect(getCoinLabel(none)).to.equal('');
        }
    });
});

describe('decoder.describe.value_format collectLockFlags', function () {
    const FIELDS = [
        ['LOCK_MAX_SUPPLY', 'max supply'],
        ['LOCK_MAX_MINT', 'max mint'],
        ['LOCK_MINT', 'minting'],
        ['LOCK_MINT_SUPPLY', 'mint-supply'],
        ['LOCK_DESCRIPTION', 'description'],
        ['LOCK_SLEEP', 'sleep'],
        ['LOCK_CALLBACK', 'callback'],
    ];

    it('returns no flags for empty params', function () {
        expect(collectLockFlags({})).to.deep.equal([]);
    });

    it('names each flag set to "1", in declaration order', function () {
        const p = {};
        for (const [field] of FIELDS) p[field] = '1';
        expect(collectLockFlags(p)).to.deep.equal(FIELDS.map(([, label]) => label));
    });

    it('names a single flag on its own', function () {
        for (const [field, label] of FIELDS) {
            expect(collectLockFlags({ [field]: '1' })).to.deep.equal([label]);
        }
    });

    it('skips falsy and zero values', function () {
        for (const off of ['0', 0, false, '', null, undefined]) {
            const p = {};
            for (const [field] of FIELDS) p[field] = off;
            expect(collectLockFlags(p), String(off)).to.deep.equal([]);
        }
    });
});
