'use strict';

const { expect } = require('chai');
const {
    multipartTransactionCount,
    standardChunkCount,
    pieceFundingValue,
    multipartFundingOutputs
} = require('../../src/file/multipart_funding.js');

const FIXED_QUOTE = {
    rate: 3,
    pairSize: 1001,
    outputFloor: 546,
    payloadBytes: 477
};

describe('multipart funding transaction and chunk counts', function () {
    it('counts 55 transactions for 26 parts', function () {
        expect(multipartTransactionCount(26)).to.equal(55);
    });

    it('changes standard chunks at the 476-byte boundary', function () {
        expect(standardChunkCount(476)).to.equal(1);
        expect(standardChunkCount(477)).to.equal(2);
    });

    it('refuses non-finite or negative count inputs', function () {
        for (const value of [NaN, Infinity, -1]) {
            expect(() => multipartTransactionCount(value)).to.throw('totalParts');
            expect(() => standardChunkCount(value)).to.throw('payloadBytes');
        }
    });
});

describe('multipart piece funding values', function () {
    it('quotes the envelope lane at a fixed rate', function () {
        expect(pieceFundingValue({ lane: 'envelope', ...FIXED_QUOTE })).to.equal(4846);
    });

    it('quotes standard pieces on both sides of the chunk boundary', function () {
        expect(pieceFundingValue({ lane: 'standard', ...FIXED_QUOTE, payloadBytes: 476 })).to.equal(4846);
        expect(pieceFundingValue({ lane: 'standard', ...FIXED_QUOTE })).to.equal(5392);
    });

    it('refuses an unknown lane', function () {
        expect(() => pieceFundingValue({ lane: 'other', ...FIXED_QUOTE })).to.throw('lane');
    });

    it('refuses every non-finite or negative numeric input', function () {
        for (const field of ['rate', 'pairSize', 'outputFloor', 'payloadBytes']) {
            for (const value of [NaN, Infinity, -Infinity, -1]) {
                const quote = { lane: 'envelope', ...FIXED_QUOTE, [field]: value };
                expect(() => pieceFundingValue(quote)).to.throw(field);
            }
        }
    });
});

describe('multipart funding outputs', function () {
    it('keeps piece order and totals the funding values', function () {
        expect(multipartFundingOutputs([4846, 5392, 7], 'source-address')).to.deep.equal({
            customOutputs: [
                { address: 'source-address', value: 4846 },
                { address: 'source-address', value: 5392 },
                { address: 'source-address', value: 7 }
            ],
            fundingTotal: 10245
        });
    });

    it('refuses non-finite and negative output values', function () {
        for (const value of [NaN, Infinity, -Infinity, -1])
            expect(() => multipartFundingOutputs([1, value], 'source-address')).to.throw('values[1]');
    });

    it('returns an empty quote for no pieces', function () {
        expect(multipartFundingOutputs([], 'source-address')).to.deep.equal({
            customOutputs: [],
            fundingTotal: 0
        });
    });
});
