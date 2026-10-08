'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pre-flight mirrors arm their regtest entry from the venue's env, as the indexer's registry overlay does.

const { expect } = require('chai');
const { ACTIVATION_MIRRORS, activationThreshold, describeActivation } = require('../../../../src/preflight/activation.js');
const { reportFor, has, unverified } = require('../checks/checks.test/helpers/setup.js');

const ENV = 'XC_LISTS_MARKET_REGTEST_ACTIVATION';
const regtest = { config: { network: 'bitcoin-regtest' }, explorer: { coin: 'RBTC' } };
const invalidList = {
    getToken: () => ({ tick: 'JDOG' }),
    getAction: () => ({ action: 'LIST', action_index: '55', status: 'invalid: TYPE' }),
};

// Run fn with the arming variable set (or unset) and restore it after.
async function withArming(value, fn) {
    const saved = process.env[ENV];
    try {
        if (value === undefined) delete process.env[ENV];
        else process.env[ENV] = value;
        return await fn();
    } finally {
        if (saved === undefined) delete process.env[ENV];
        else process.env[ENV] = saved;
    }
}

describe('pre-flight activation mirrors follow regtest venue arming', function () {
    it('reads the list reference validity height from the arming variable on regtest', async function () {
        await withArming('701', () => {
            expect(activationThreshold('LIST_REFERENCE_VALIDITY', regtest)).to.equal(701);
            expect(describeActivation('LIST_REFERENCE_VALIDITY')).to.contain('armed at height 701 on regtest');
        });
        await withArming(undefined, () => {
            expect(activationThreshold('LIST_REFERENCE_VALIDITY', regtest)).to.equal(0);
        });
    });

    it('leaves the pinned table and the non-regtest planes untouched when armed', async function () {
        await withArming('701', () => {
            expect(ACTIVATION_MIRRORS.LIST_REFERENCE_VALIDITY.table.regtest).to.equal(0);
            const testnet = { config: { network: 'bitcoin-testnet' }, explorer: { coin: 'TBTC' } };
            expect(activationThreshold('LIST_REFERENCE_VALIDITY', testnet)).to.equal(155001);
        });
    });

    it('an invalid LIST is conditional, not an error, on a venue armed above genesis', async function () {
        const r = await withArming('701', () => reportFor('AIRDROP|0|JDOG|1|55', invalidList));
        expect(has(r, 'LIST_NOT_FOUND', 'error')).to.equal(false);
        expect(unverified(r, 'LIST_REFERENCE_VALIDITY')).to.equal(true);
    });

    it('an invalid LIST stays an error on a venue armed at genesis', async function () {
        const r = await withArming('armed', () => reportFor('AIRDROP|0|JDOG|1|55', invalidList));
        expect(has(r, 'LIST_NOT_FOUND', 'error')).to.equal(true);
    });
});
