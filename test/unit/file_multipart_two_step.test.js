/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const {
    twoStepCommitParams,
    twoStepRevealParams,
    twoStepRecoveryRecord,
} = require('../../src/file/multipart_two_step.js');

function params(overrides = {}) {
    return {
        encoding: 'TAPROOT',
        pubkey: '02abc',
        utxos: [{ txid: 'funding', vout: 1 }],
        data: 'FILE|2|hash|0',
        rawData: Buffer.from('part'),
        compress: false,
        unused: undefined,
        options: { exactInputs: true, signerSupportsTapscript: true, unused: undefined },
        ...overrides,
    };
}

function expectFieldError(call, field) {
    expect(call).to.throw(Error, new RegExp(field));
    try {
        call();
    } catch (error) {
        expect(error.constructor).to.equal(Error);
    }
}

function containsUndefined(value) {
    if (!value || typeof value !== 'object') return false;
    return Object.values(value).some((item) => item === undefined || containsUndefined(item));
}

describe('multipart two-step parameter builds', function () {
    it('builds exact commit and reveal shapes that differ only in options', function () {
        const input = params();
        const commit = twoStepCommitParams(input);
        const reveal = twoStepRevealParams(input, 'aabb');
        const expectedKeys = ['compress', 'data', 'encoding', 'options', 'pubkey', 'rawData', 'utxos'];
        expect(Object.keys(commit).sort()).to.deep.equal(expectedKeys);
        expect(Object.keys(reveal).sort()).to.deep.equal(expectedKeys);
        expect(commit.options).to.deep.equal({
            exactInputs: true, signerSupportsTapscript: true, twoStepEnvelope: true,
        });
        expect(reveal.options).to.deep.equal({
            envelopeCommitHex: 'aabb', signerSupportsTapscript: true,
        });
        expect({ ...commit, options: null }).to.deep.equal({ ...reveal, options: null });
        expect(commit.options).not.to.have.property('envelopeCommitHex');
        expect(reveal.options).not.to.have.any.keys('exactInputs', 'twoStepEnvelope');
        expect(containsUndefined(commit)).to.equal(false);
        expect(containsUndefined(reveal)).to.equal(false);
    });

    it('carries signer capability only when the input carries it', function () {
        const withoutSigner = params({ options: { exactInputs: true } });
        const withFalseSigner = params({ options: { signerSupportsTapscript: false } });
        expect(twoStepRevealParams(withoutSigner, '00').options)
            .to.deep.equal({ envelopeCommitHex: '00' });
        expect(twoStepRevealParams(withFalseSigner, '00').options)
            .to.deep.equal({ envelopeCommitHex: '00', signerSupportsTapscript: false });
    });
});

describe('multipart two-step parameter validation', function () {
    for (const [field, bad] of [
        ['params', null],
        ['encoding', params({ encoding: 'P2SH' })],
        ['p2shHash', params({ p2shHash: undefined })],
        ['pubkey', params({ pubkey: undefined })],
        ['pubkey', params({ pubkey: '' })],
        ['utxos', params({ utxos: undefined })],
        ['utxos', params({ utxos: [] })],
        ['utxos', params({ utxos: {} })],
    ]) {
        it(`refuses an invalid ${field}`, function () {
            expectFieldError(() => twoStepCommitParams(bad), field);
            expectFieldError(() => twoStepRevealParams(bad, '00'), field);
        });
    }

    for (const signedCommitHex of [undefined, '', '0', '0g', 'aab']) {
        it(`refuses signed commit hex ${String(signedCommitHex)}`, function () {
            expectFieldError(() => twoStepRevealParams(params(), signedCommitHex), 'signedCommitHex');
        });
    }
});

describe('multipart two-step recovery records', function () {
    it('returns the reveal envelope record', function () {
        const envelope = { commitTxid: 'commit', revealTxid: 'reveal' };
        expect(twoStepRecoveryRecord({ envelope })).to.equal(envelope);
    });

    for (const result of [undefined, {}, { envelope: {} }, { envelope: { commitTxid: '' } }]) {
        it('refuses a response without a commit transaction id', function () {
            expect(() => twoStepRecoveryRecord(result)).to.throw(Error)
                .with.property('code', 'ENVELOPE_COMMIT_TXID_MISSING');
        });
    }
});

describe('multipart two-step input immutability', function () {
    it('does not mutate builder or recovery inputs', function () {
        const input = params();
        const options = input.options;
        const utxos = input.utxos;
        const envelope = { commitTxid: 'commit' };
        const result = { envelope };
        const beforeKeys = Object.keys(input);
        const commit = twoStepCommitParams(input);
        const reveal = twoStepRevealParams(input, 'aabb');
        twoStepRecoveryRecord(result);
        expect(Object.keys(input)).to.deep.equal(beforeKeys);
        expect(commit).not.to.equal(input);
        expect(reveal).not.to.equal(input);
        expect(commit.options).not.to.equal(input.options);
        expect(reveal.options).not.to.equal(input.options);
        expect(input.options).to.equal(options);
        expect(input.utxos).to.equal(utxos);
        expect(input.options).to.deep.equal({
            exactInputs: true, signerSupportsTapscript: true, unused: undefined,
        });
        expect(result).to.deep.equal({ envelope: { commitTxid: 'commit' } });
    });
});
