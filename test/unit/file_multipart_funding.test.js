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

    // Rail needs: bitcoin floor 546 with pairFee 543 needs 1638; litecoin floor 5460
    // with pairFee 540 and the stripped-size reveal pad needs 21840.
    it('lifts a small bitcoin envelope piece over the encoder floors', function () {
        const quote = { lane: 'envelope', rate: 1, pairSize: 434, outputFloor: 546, payloadBytes: 0 };
        const value = pieceFundingValue(quote);
        expect(value).to.equal(2184);
        expect(value).to.be.at.least(1638);
    });

    it('adds the litecoin reveal pad to a small envelope piece', function () {
        const quote = { lane: 'envelope', rate: 1, pairSize: 432, outputFloor: 5460, payloadBytes: 0 };
        const value = pieceFundingValue({ ...quote, revealPad: true });
        expect(value).to.equal(27300);
        expect(value).to.be.at.least(21840);
        expect(pieceFundingValue(quote)).to.equal(21840);
    });

    it('floors a small standard piece at the commit fee floor', function () {
        const quote = { lane: 'standard', rate: 1, pairSize: 100, outputFloor: 546, payloadBytes: 476 };
        expect(pieceFundingValue(quote)).to.equal(546 + (2 * 546));
    });

    it('refuses a non-boolean revealPad', function () {
        expect(() => pieceFundingValue({ lane: 'envelope', ...FIXED_QUOTE, revealPad: 1 })).to.throw('revealPad');
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
