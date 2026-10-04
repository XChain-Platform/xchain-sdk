'use strict';

const { expect } = require('chai');
const {
    isCanonicalTick,
    isTickField,
    validateDecodedParams,
    ownLookup,
    TICK_REGEX,
    TICK_REF_REGEX,
    MAX_TICK_LENGTH,
} = require('../../../../src/cosigner/policy/param_charset.js');

describe('co-signer parameter charset', function () {

    it('exports the canonical tick constraints', function () {
        expect(MAX_TICK_LENGTH).to.equal(250);
        expect(TICK_REGEX).to.be.instanceOf(RegExp);
        expect(TICK_REF_REGEX).to.be.instanceOf(RegExp);
    });

    it('recognizes canonical tick values', function () {
        const valid = ['SAT', '^12', 'A.B', 'A$%', 'A'.repeat(250)];
        const invalid = ['', 'A..B', '.A', 'A B', 'A'.repeat(251), 5, null, undefined];

        for (const value of valid) expect(isCanonicalTick(value), String(value)).to.equal(true);
        for (const value of invalid) expect(isCanonicalTick(value), String(value)).to.equal(false);
    });

    it('recognizes only tick field names', function () {
        for (const field of ['TICK', 'GIVE_TICK']) expect(isTickField(field), field).to.equal(true);
        for (const field of ['TICKER', 'TICK_X', 5, undefined]) {
            expect(isTickField(field), String(field)).to.equal(false);
        }
    });

    it('accepts values that do not require tick validation', function () {
        const accepted = [
            null,
            'params',
            { MEMO: 'bad tick' },
            { TICK: undefined },
            { TICK: null },
            { TICK: '' },
        ];

        for (const params of accepted) expect(validateDecodedParams(params)).to.deep.equal({ ok: true });
    });

    it('reports invalid tick fields and bounds the returned value', function () {
        expect(validateDecodedParams({ TICK: 'bad tick' })).to.deep.equal({
            ok: false,
            field: 'TICK',
            value: 'bad tick',
        });

        const longTick = 'A'.repeat(300);
        expect(validateDecodedParams({ GET_TICK: longTick })).to.deep.equal({
            ok: false,
            field: 'GET_TICK',
            value: longTick.slice(0, 64),
        });
    });

    it('reads only own properties addressed by strings or numbers', function () {
        const table = { own: 'value', 5: 'number value', '[object Object]': 'coerced value' };

        expect(ownLookup(table, 'own')).to.equal('value');
        expect(ownLookup(table, 5)).to.equal('number value');
        expect(ownLookup(table, 'toString')).to.equal(undefined);
        expect(ownLookup(null, 'own')).to.equal(undefined);
        expect(ownLookup(table, {})).to.equal(undefined);
    });
});
