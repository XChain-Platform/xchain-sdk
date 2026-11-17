'use strict';

const { expect } = require('chai');
const {
    MULTIPART_WAVE_PIECES,
    multipartFundingWaves,
    multipartWaveCount,
    multipartTransactionCount
} = require('../../src/file/multipart_funding.js');

describe('multipart funding waves', function () {
    it('splits 251 pieces into consecutive waves with the manifest first', function () {
        const parts = Array.from({ length: 250 }, (_, index) => ({ kind: 'part', index }));
        const manifest = { kind: 'manifest', index: -1 };
        const waves = multipartFundingWaves(parts.concat(manifest), MULTIPART_WAVE_PIECES);

        expect(waves.map(wave => wave.index)).to.deep.equal([0, 1, 2]);
        expect(waves.map(wave => wave.pieces.length)).to.deep.equal([100, 100, 51]);
        expect(waves.flatMap(wave => wave.pieces)).to.deep.equal([manifest].concat(parts));
    });

    it('counts the manifest and parts across wave boundaries', function () {
        expect(multipartWaveCount(99, MULTIPART_WAVE_PIECES)).to.equal(1);
        expect(multipartWaveCount(100, MULTIPART_WAVE_PIECES)).to.equal(2);
    });

    it('refuses wave sizes outside the encoder output bound', function () {
        for (const waveSize of [0, 101, 1.5]) {
            expect(() => multipartFundingWaves([], waveSize)).to.throw('waveSize');
            expect(() => multipartWaveCount(0, waveSize)).to.throw('waveSize');
        }
    });

    it('counts funding waves and piece transactions', function () {
        expect(multipartTransactionCount(26)).to.equal(55);
        expect(multipartTransactionCount(250)).to.equal(505);
    });
});
