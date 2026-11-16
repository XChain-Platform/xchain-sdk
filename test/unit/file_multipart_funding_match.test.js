'use strict';

const { expect } = require('chai');
const {
    matchFundingOutputs,
    fundingMatchesQuote
} = require('../../src/file/multipart_funding_match.js');

const txid = 'ab'.repeat(32);

function output(vout, address, value) {
    return { vout, address, value, scriptPubKey: `script-${vout}` };
}

describe('multipart funding output matching', function () {
    it('pins same-value pieces to different outputs in piece order', function () {
        const expected = [
            { address: 'piece-address', value: 1200 },
            { address: 'piece-address', value: 1200 }
        ];
        const outputs = [
            output(7, 'piece-address', 1200),
            output(3, 'piece-address', 1200)
        ];

        expect(matchFundingOutputs(expected, outputs, txid)).to.deep.equal([
            { txid, vout: 7, value: 1200, scriptPubKey: 'script-7' },
            { txid, vout: 3, value: 1200, scriptPubKey: 'script-3' }
        ]);
    });

    it('matches shuffled transaction outputs while preserving piece order', function () {
        const expected = [
            { address: 'first', value: 1100 },
            { address: 'second', value: 2200 },
            { address: 'third', value: 3300 }
        ];
        const outputs = [
            output(4, 'third', 3300),
            output(1, 'first', 1100),
            output(2, 'second', 2200)
        ];

        expect(matchFundingOutputs(expected, outputs, txid).map(match => match.vout))
            .to.deep.equal([1, 2, 4]);
    });

    it('ignores an extra change output', function () {
        const expected = [{ address: 'piece', value: 2500 }];
        const outputs = [
            output(0, 'change', 9000),
            output(1, 'piece', 2500)
        ];

        expect(matchFundingOutputs(expected, outputs, txid)).to.deep.equal([
            { txid, vout: 1, value: 2500, scriptPubKey: 'script-1' }
        ]);
    });

    it('does not take a protocol-fee output equal in value to a piece', function () {
        const expected = [{ address: 'piece', value: 1800 }];
        const outputs = [
            output(0, 'fee-destination', 1800),
            output(5, 'piece', 1800)
        ];

        expect(matchFundingOutputs(expected, outputs, txid)[0].vout).to.equal(5);
    });
});

describe('multipart funding output mismatch handling', function () {
    it('throws a coded error naming the missing piece index', function () {
        const expected = [
            { address: 'present', value: 1000 },
            { address: 'missing', value: 2000 }
        ];

        expect(() => matchFundingOutputs(expected, [output(0, 'present', 1000)], txid))
            .to.throw(Error, 'piece index 1')
            .with.property('code', 'FUNDING_OUTPUT_MISSING');
        expect(fundingMatchesQuote(expected, [output(0, 'present', 1000)])).to.equal(false);
    });

    it('rejects a value off by one', function () {
        const expected = [{ address: 'piece', value: 4000 }];
        const outputs = [output(0, 'piece', 3999)];

        expect(() => matchFundingOutputs(expected, outputs, txid))
            .to.throw(Error, 'piece index 0')
            .with.property('code', 'FUNDING_OUTPUT_MISSING');
        expect(fundingMatchesQuote(expected, outputs)).to.equal(false);
    });
});

describe('multipart funding quote matching', function () {
    it('accepts an empty expected output list', function () {
        const outputs = [output(0, 'change', 5000)];

        expect(matchFundingOutputs([], outputs, txid)).to.deep.equal([]);
        expect(fundingMatchesQuote([], outputs)).to.equal(true);
    });

    it('reports a matching quote without exposing transaction fields', function () {
        const expected = [{ address: 'piece', value: 1000 }];
        const outputs = [output(2, 'piece', 1000)];

        expect(fundingMatchesQuote(expected, outputs)).to.equal(true);
    });
});
