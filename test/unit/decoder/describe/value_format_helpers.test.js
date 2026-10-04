'use strict';

const { expect } = require('chai');
const {
    genericFallback, str, firstStr, toArray, safeJson,
} = require('../../../../src/decoder/describe/value_format.js');

describe('decoder.describe value_format helpers', function () {
    it('str maps null and undefined to the empty string', function () {
        expect(str(null)).to.equal('');
        expect(str(undefined)).to.equal('');
    });

    it('str joins arrays and stringifies scalars', function () {
        expect(str(['a', 1])).to.equal('a, 1');
        expect(str(5)).to.equal('5');
    });

    it('firstStr returns the first slot of a joined list', function () {
        expect(firstStr('a, b')).to.equal('a');
    });

    it('toArray gives an empty array for null, undefined and the empty string', function () {
        expect(toArray(null)).to.deep.equal([]);
        expect(toArray(undefined)).to.deep.equal([]);
        expect(toArray('')).to.deep.equal([]);
    });

    it('toArray drops null, undefined and empty entries from an array', function () {
        expect(toArray([1, '', null, undefined, 2])).to.deep.equal([1, 2]);
    });

    it('toArray wraps a scalar, keeping 0', function () {
        expect(toArray('x')).to.deep.equal(['x']);
        expect(toArray(0)).to.deep.equal([0]);
    });

    it('safeJson serializes and falls back to String on a circular object', function () {
        expect(safeJson({ a: 1 })).to.equal('{"a":1}');
        const loop = {};
        loop.self = loop;
        expect(safeJson(loop)).to.equal(String(loop));
    });

    it('genericFallback names an unknown action and humanizes the parameters', function () {
        const out = genericFallback(null, { VERSION: '0', MAX_SUPPLY: '5', OBJ: { a: 1 } }, ' (x)');
        expect(out.summary).to.equal('Sign unknown action (x)');
        expect(out.details).to.deep.equal([
            { label: 'Max supply', value: '5' },
            { label: 'Obj', value: '{"a":1}' },
        ]);
        expect(out.warnings).to.have.length(1);
        expect(out.warnings[0]).to.include('unknown action');
    });
});
