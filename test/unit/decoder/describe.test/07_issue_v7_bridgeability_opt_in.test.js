'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const { parse } = require('../../../../src/decoder/parse.js');
const { describe: describeAction } = require('../../../../src/decoder/describe.js');

describe('describe: ISSUE v7 bridgeability opt-in', function () {

    // Before the v7 branch this fell through to the v0 create-or-update path and
    // read "Configure token FUFU": the screen said nothing about opting the token
    // into cross-chain movement, nor about LOCK_BRIDGE freezing it forever.
    it('names the chains the token is being opened to', function () {
        const d = describeAction(parse('ISSUE|7|FUFU|DOGE,LTC|3|1|opt in'));
        expect(d.summary).to.equal('Allow FUFU to bridge to DOGE,LTC');
        expect(d.details.find(x => x.label === 'Bridgeable to').value).to.equal('DOGE,LTC');
        expect(d.details.find(x => x.label === 'Minimum confirmations').value).to.equal('3');
        expect(d.warnings.join('\n')).to.match(/Locking is permanent/);
        expect(d.warnings.join('\n')).to.match(/bridged copy this chain does not control/);
    });

    it("reads the '-' clear sentinel as turning bridging off, not as a chain list", function () {
        const d = describeAction(parse('ISSUE|7|FUFU|-'));
        expect(d.summary).to.equal('Disable bridging for FUFU');
        expect(d.details.find(x => x.label === 'Bridgeable to').value).to.equal('nothing (bridging off)');
        // Nothing is being opened, so the holders-can-move warning must not fire.
        expect(d.warnings.join('\n')).to.not.match(/bridged copy/);
    });

    it('an empty BRIDGE_CHAINS means unchanged, and says so rather than claiming a change', function () {
        const d = describeAction(parse('ISSUE|7|FUFU||6'));
        expect(d.summary).to.equal('Update bridge settings of FUFU');
        expect(d.details.find(x => x.label === 'Bridgeable to')).to.equal(undefined);
        expect(d.details.find(x => x.label === 'Minimum confirmations').value).to.equal('6');
    });
});
