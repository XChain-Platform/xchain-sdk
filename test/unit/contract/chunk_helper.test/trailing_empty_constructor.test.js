// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const { expect } = require('chai');
const { XChainSDK } = require('../../../../index.js');
const chunkHelper = require('../../../../src/contract/chunk_helper.js');

const sdk = new XChainSDK({ network: 'bitcoin-regtest' });

function compiledSize(source, constructorParams, gasLimit = 100000) {
    const composed = sdk.actions.composeActionString({ action: 'DEPLOY', params: {
        CODE: source, GAS_LIMIT: gasLimit, CONSTRUCTOR_PARAMS: constructorParams
    } });
    expect(composed.version).to.equal(0);
    return Buffer.byteLength(composed.actionString, 'utf8') + chunkHelper.OP_RETURN_PUSH_OVERHEAD;
}

function compiledStakeableSize(source, constructorParams) {
    const composed = sdk.actions.composeActionString({ action: 'DEPLOY', params: {
        CODE: source, GAS_LIMIT: 100000, CONSTRUCTOR_PARAMS: constructorParams, COOLDOWN_BLOCKS: 10
    } });
    expect(composed.version).to.equal(1);
    return Buffer.byteLength(composed.actionString, 'utf8') + chunkHelper.OP_RETURN_PUSH_OVERHEAD;
}

function frontier(opts) {
    let low = 1, high = 7000, largest = 0;
    while (low <= high) {
        const mid = (low + high) >> 1;
        if (chunkHelper.fitsSingleDeploy('x'.repeat(mid), opts)) { largest = mid; low = mid + 1; }
        else high = mid - 1;
    }
    return largest;
}

describe('chunkHelper trailing empty constructor fields', function () {
    it('matches the composer frontier and keeps the reported deploy inline', function () {
        const opts = { gasLimit: 10000, constructorParams: ['a', ''] };
        const largest = frontier(opts);
        expect(compiledSize('x'.repeat(largest), opts.constructorParams, opts.gasLimit)).to.be.at.most(chunkHelper.MAX_ACTION_DATA_LENGTH);
        expect(compiledSize('x'.repeat(largest + 1), opts.constructorParams, opts.gasLimit)).to.be.above(chunkHelper.MAX_ACTION_DATA_LENGTH);
        expect(compiledSize('x'.repeat(6129), opts.constructorParams, opts.gasLimit)).to.equal(chunkHelper.MAX_ACTION_DATA_LENGTH);
        expect(chunkHelper.planDeploy('x'.repeat(6129), opts).single).to.equal(true);
    });

    it('treats all-empty constructor fields like an absent constructor', function () {
        expect(frontier({ gasLimit: 100000, constructorParams: ['', ''] }))
            .to.equal(frontier({ gasLimit: 100000 }));
    });

    it('continues to count null as its serialized text', function () {
        const opts = { gasLimit: 100000, constructorParams: [null] };
        const largest = frontier(opts);
        expect(compiledSize('x'.repeat(largest), opts.constructorParams)).to.be.at.most(chunkHelper.MAX_ACTION_DATA_LENGTH);
        expect(compiledSize('x'.repeat(largest + 1), opts.constructorParams)).to.be.above(chunkHelper.MAX_ACTION_DATA_LENGTH);
    });

    it('counts a bare null at the same v0 frontier as the composer', function () {
        const opts = { gasLimit: 100000, constructorParams: null };
        const largest = frontier(opts);
        expect(compiledSize('x'.repeat(largest), null)).to.be.at.most(chunkHelper.MAX_ACTION_DATA_LENGTH);
        expect(compiledSize('x'.repeat(largest + 1), null)).to.be.above(chunkHelper.MAX_ACTION_DATA_LENGTH);
        expect(chunkHelper.planDeploy('x'.repeat(6129), opts).single).to.equal(false);
    });

    it('counts a bare null at the same v1 frontier as the composer', function () {
        const opts = { gasLimit: 100000, constructorParams: null, cooldownBlocks: 10 };
        const largest = frontier(opts);
        expect(compiledStakeableSize('x'.repeat(largest), null)).to.be.at.most(chunkHelper.MAX_ACTION_DATA_LENGTH);
        expect(compiledStakeableSize('x'.repeat(largest + 1), null)).to.be.above(chunkHelper.MAX_ACTION_DATA_LENGTH);
    });
});
