// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const { expect } = require('chai');
const { XChainSDK } = require('../../../../index.js');
const chunkHelper = require('../../../../src/contract/chunk_helper.js');

function frontier(opts) {
    let low = 1;
    let high = 7000;
    let largest = 0;
    while (low <= high) {
        const mid = (low + high) >> 1;
        if (chunkHelper.fitsSingleDeploy('x'.repeat(mid), opts)) {
            largest = mid;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }
    return largest;
}

function compiledDeploy(srcBytes, params) {
    const sdk = new XChainSDK({ network: 'bitcoin-regtest' });
    const composed = sdk.actions.composeActionString({
        action: 'DEPLOY', params: Object.assign({ CODE: 'x'.repeat(srcBytes) }, params),
    });
    return Buffer.byteLength(composed.actionString, 'utf8') + chunkHelper.OP_RETURN_PUSH_OVERHEAD;
}

describe('chunkHelper numeric wire normalization', function () {
    it('matches exponent, canonical, and leading-zero gas spellings at the boundary', function () {
        const exponent = frontier({ gasLimit: '1e6' });
        const canonical = frontier({ gasLimit: '1000000' });
        const leading = frontier({ gasLimit: '01000000' });
        expect(exponent).to.equal(canonical);
        expect(leading).to.equal(canonical);
        expect(compiledDeploy(exponent, { GAS_LIMIT: '1e6' }))
            .to.be.at.most(chunkHelper.MAX_ACTION_DATA_LENGTH);
        expect(compiledDeploy(exponent + 1, { GAS_LIMIT: '1e6' }))
            .to.be.above(chunkHelper.MAX_ACTION_DATA_LENGTH);
        expect(chunkHelper.planDeploy('x'.repeat(6132), { gasLimit: '1e6' }).single).to.equal(false);
        expect(chunkHelper.planDeploy('x'.repeat(6129), { gasLimit: '1e6' }).single).to.equal(true);
    });

    it('normalizes the staking cooldown before sizing the v1 tail', function () {
        const base = {
            gasLimit: '100000', constructorParams: ['alice'],
            slashDestination: 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080',
        };
        const exponent = frontier(Object.assign({}, base, { cooldownBlocks: '1.44e2' }));
        const canonical = frontier(Object.assign({}, base, { cooldownBlocks: '144' }));
        expect(exponent).to.equal(canonical);
        expect(compiledDeploy(exponent, {
            GAS_LIMIT: base.gasLimit, CONSTRUCTOR_PARAMS: base.constructorParams,
            COOLDOWN_BLOCKS: '1.44e2', SLASH_DESTINATION: base.slashDestination,
        })).to.be.at.most(chunkHelper.MAX_ACTION_DATA_LENGTH);
    });
});
