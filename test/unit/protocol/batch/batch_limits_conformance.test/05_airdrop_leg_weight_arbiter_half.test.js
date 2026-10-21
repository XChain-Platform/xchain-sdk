'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The per-leg AIRDROP weight against the arbiter itself: the sibling indexer's
// BATCH handler loads on regtest, where BATCH_AIRDROP_LEG_WEIGHT is armed from
// genesis, so its weight for each multi-leg shape must equal the mirror's at the
// same network and height.

const { expect } = require('chai');
const { loadBatchArbiter } = require('../../../../helpers/indexer_action_handler.js');
const { subCommandWeight } = require('../../../../../src/protocol/batch_limits.js');

const LEG_VECTORS = [
    'AIRDROP|0|JDOG|1|5',
    'AIRDROP|0|JDOG|1|5|memo',
    'AIRDROP|1|5|JDOG|1',
    'AIRDROP|1|5|JDOG|1|XCP|2',
    'AIRDROP|1|5|JDOG|1|XCP|2|memo',
    'AIRDROP|2|JDOG|1|5|XCP|2|6|SAT|3|7',
    'AIRDROP|2|JDOG|1|5|XCP|2|6|memo',
    'AIRDROP|3|JDOG|1|5|m1|XCP|2|6|m2',
    'DROP|1|5|JDOG|1|XCP|2',
    'AIRDROP|zz',
];

function makeArbiter(dependencies) {
    const { Batch, IdxUtility, IdxConfig } = dependencies;
    const config = typeof IdxConfig.getConfig === 'function' ? IdxConfig.getConfig() : IdxConfig;
    return new Batch({
        config, util: new IdxUtility(), decoderDb: {}, indexerDb: {},
        mapper: { createMappings: async () => {} },
        protocolChanges: { isEnabled: async () => true },
        processAction: async () => {},
        actionAliases: { TRANSFER: 'SEND', ADDR: 'ADDRESS', DROP: 'AIRDROP', CAST: 'BROADCAST', MSG: 'MESSAGE' },
    });
}

describe('BATCH limit-scan conformance (SDK mirror vs arbiter)', function () {
    describe('per-leg AIRDROP weight (BATCH_AIRDROP_LEG_WEIGHT), arbiter half', function () {
        let arbiter = null;

        before(function () {
            this.timeout(30000);
            const dependencies = loadBatchArbiter(this, 'the per-leg AIRDROP weight arbiter half');
            if (dependencies) arbiter = makeArbiter(dependencies);
        });

        for (const command of LEG_VECTORS) {
            it('weighs ' + command + ' as the arbiter does on regtest', async function () {
                this.timeout(20000);
                const expected = await arbiter.batchWeight([command], { BLOCK_INDEX: 200 }, true);
                expect(subCommandWeight(command, { network: 'regtest', height: 200 })).to.equal(expected);
            });
        }

        it('sees a multi-leg weight on the arbiter side, so the parity cases are not all flat', async function () {
            this.timeout(20000);
            expect(await arbiter.batchWeight(['AIRDROP|2|JDOG|1|5|XCP|2|6|SAT|3|7'], { BLOCK_INDEX: 200 }, true))
                .to.equal(75);
        });
    });
});
