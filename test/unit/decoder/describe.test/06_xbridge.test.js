'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const { parse } = require('../../../../src/decoder/parse.js');
const { describe: describeAction } = require('../../../../src/decoder/describe.js');

const GENERIC = /No plain-English summary is available/;

// XBRIDGE and ISSUE v7: the cross-chain bridge on the confirm screen.
//
// Both arrived together and both are places a generic or
// near-generic description is actively dangerous: the funds leave this chain
// and the credit lands somewhere this screen cannot verify, so the leg, the
// asset, the counterparty and the irreversibility all have to be stated.

describe('describe: XBRIDGE', function () {

    it('a v0 lock names the amount, the destination chain and the address', function () {
        const d = describeAction(parse('XBRIDGE|0|DOGE|DQhLcGV1NNsJAPk9EQkTFMBAV7wKuMJ7RY|5.5|to doge'));
        expect(d.summary).to.equal(
            'Bridge 5.5 XCHAIN to DOGE address DQhLcGV1NNsJAPk9EQkTFMBAV7wKuMJ7RY');
        // v0 carries no TICK field: the asset is the gas token by definition.
        expect(d.details.find(x => x.label === 'Token').value).to.equal('XCHAIN');
        expect(d.details.find(x => x.label === 'Destination chain').value).to.equal('DOGE');
        expect(d.details.find(x => x.label === 'Credit to').value)
            .to.equal('DQhLcGV1NNsJAPk9EQkTFMBAV7wKuMJ7RY');
        expect(d.warnings.join('\n')).to.match(/locks the tokens here and credits them on another chain/);
        expect(d.warnings.join('\n')).to.match(/cannot be undone or redirected/);
    });

    it('a v1 burn is described as a burn-and-release, not as another lock', function () {
        const d = describeAction(parse('XBRIDGE|1|1BoatSLRHtKNngkdXEeobR76b53LETtpyT|2'));
        expect(d.summary).to.equal('Bridge 2 XCHAIN back to 1BoatSLRHtKNngkdXEeobR76b53LETtpyT');
        expect(d.details.find(x => x.label === 'Release to').value)
            .to.equal('1BoatSLRHtKNngkdXEeobR76b53LETtpyT');
        expect(d.details.find(x => x.label === 'Credit to')).to.equal(undefined);
        expect(d.warnings.join('\n')).to.match(/burns the tokens here and releases them/);
    });

    it('a v3 token lock names the token from TICK, not the gas default', function () {
        const d = describeAction(parse('XBRIDGE|3|FUFU|DOGE|DQhLcGV1NNsJAPk9EQkTFMBAV7wKuMJ7RY|10'));
        expect(d.summary).to.equal(
            'Bridge 10 FUFU to DOGE address DQhLcGV1NNsJAPk9EQkTFMBAV7wKuMJ7RY');
        expect(d.details.find(x => x.label === 'Token').value).to.equal('FUFU');
    });

    it('a v4 burn names the bridged copy it is sending home', function () {
        const d = describeAction(parse('XBRIDGE|4|BTC.FUFU|1BoatSLRHtKNngkdXEeobR76b53LETtpyT|3'));
        expect(d.summary).to.equal('Bridge 3 BTC.FUFU back to 1BoatSLRHtKNngkdXEeobR76b53LETtpyT');
        expect(d.details.find(x => x.label === 'Token').value).to.equal('BTC.FUFU');
        expect(d.warnings.join('\n')).to.match(/burns the tokens here/);
    });

    // v2 and v5 are injected by the indexer and formats.js omits them, so they
    // cannot arrive through parse(). A wallet that met one anyway must be told
    // not to sign it rather than be handed the generic shrug.
    for (const version of [2, 5]) {
        it(`a v${version} settle leg is described as system-injected and unsignable`, function () {
            const d = describeAction({ action: 'XBRIDGE', version, params: { TICK: 'FUFU', AMOUNT: '5' } });
            expect(d.summary).to.equal('Bridge settlement leg (system-injected)');
            expect(d.warnings.join('\n')).to.match(/do not sign it/);
            expect(d.warnings.join('\n')).to.not.match(GENERIC);
        });
    }

    it('flags an empty address and a non-positive amount', function () {
        const d = describeAction({ action: 'XBRIDGE', version: 0, params: { DEST_COIN: 'DOGE', AMOUNT: '0' } });
        expect(d.warnings.join('\n')).to.match(/Amount is not positive/);
        expect(d.warnings.join('\n')).to.match(/Destination address is empty/);
    });
});
