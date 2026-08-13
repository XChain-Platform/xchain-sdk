'use strict';

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 **********************************************************************
 * R2b on the COMPOSE side: batchBuilder and validator.
 *
 * scanBatch, decoder/parse.js and the arbiter itself are covered by
 * batchLimitsConformance.test.js and batchGrammar.test.js. These two sites are
 * not, and they were the last two walking `Object.keys(counts)` - the exact
 * incidental ordering R2b exists to remove.
 *
 * Neither of them picks a CONSENSUS string: they run before broadcast, so the
 * chain never sees their verdict. What they do pick is which limit a composing
 * caller is told about first, and a caller that fixes the reported problem only
 * to be handed a different one in a different order is being led in circles.
 * Same rule, same reason, lower stakes.
 ********************************************************************/

const { expect } = require('chai');
const XChainSDK = require('../../src/XChainSDK.js');
const Validator = require('../../src/validator.js');
const Utility = require('../../src/utility.js');

const validator = new Validator(new Utility());

// The reported action out of a static BATCH validation, or null.
function reportedCap(command) {
    const errors = validator.validate('BATCH', { VERSION: '0', COMMAND: command }) || [];
    const hit = errors.find((e) => e.code === 'BATCH_CONSTRAINT' && /at most/.test(e.message));
    return hit ? hit.message : null;
}

// The action named by the FIRST BATCH_CONSTRAINT the builder throws, or null.
function builderThrow(queue) {
    const sdk = new XChainSDK({ network: 'bitcoin-regtest' });
    const batch = sdk.batch();
    for (const [action, params] of queue) batch.add(action, params);
    try {
        batch._validate();
        return null;
    } catch (e) {
        return e.message;
    }
}

describe('R2b: per-ACTION cap precedence on the compose side', function () {

    describe('validator._validateBatch (wire strings)', function () {

        it('names the cap whose action appears FIRST when two are broken', function () {
            // Two DEPLOYs and two undotted ISSUEs. DEPLOY leads.
            const msg = reportedCap(
                'DEPLOY|0|a;ISSUE|0|JDOG|1;DEPLOY|0|b;ISSUE|0|OTHER|1');
            expect(msg).to.match(/DEPLOY/);
        });

        it('reports the OTHER one when the order is reversed, on the same two breaks', function () {
            // Identical breaks, ISSUE first. If this and the case above ever
            // agree, the order stopped being read from the command list.
            const msg = reportedCap(
                'ISSUE|0|JDOG|1;DEPLOY|0|a;ISSUE|0|OTHER|1;DEPLOY|0|b');
            expect(msg).to.match(/ISSUE/);
        });

        it('a LARGER overage does not jump the queue', function () {
            // DEPLOY breaks its cap by 1, ISSUE by 2. First appearance wins, so
            // an implementation that sorted by severity would fail here.
            const msg = reportedCap(
                'DEPLOY|0|a;DEPLOY|0|b;ISSUE|0|A|1;ISSUE|0|B|1;ISSUE|0|C|1');
            expect(msg).to.match(/DEPLOY/);
        });
    });

    describe('BatchBuilder._validate (compose-time params)', function () {

        it('names the cap whose action appears FIRST when two are broken', function () {
            const msg = builderThrow([
                ['DEPLOY', { GAS_LIMIT: '1' }],
                ['ISSUE', { TICK: 'JDOG', MAX_SUPPLY: '1' }],
                ['DEPLOY', { GAS_LIMIT: '1' }],
                ['ISSUE', { TICK: 'OTHER', MAX_SUPPLY: '1' }],
            ]);
            expect(msg).to.match(/DEPLOY/);
        });

        it('reports the OTHER one when the order is reversed, on the same two breaks', function () {
            const msg = builderThrow([
                ['ISSUE', { TICK: 'JDOG', MAX_SUPPLY: '1' }],
                ['DEPLOY', { GAS_LIMIT: '1' }],
                ['ISSUE', { TICK: 'OTHER', MAX_SUPPLY: '1' }],
                ['DEPLOY', { GAS_LIMIT: '1' }],
            ]);
            expect(msg).to.match(/ISSUE/);
        });

        it('a child ISSUE does not take the top-level slot, so DEPLOY still leads', function () {
            // The dotted children are exempt and must not put ISSUE into the
            // order at all for cap purposes: only the ONE top-level ISSUE does,
            // and it appears after both DEPLOYs.
            const msg = builderThrow([
                ['DEPLOY', { GAS_LIMIT: '1' }],
                ['ISSUE', { TICK: 'JDOG.1', MAX_SUPPLY: '1' }],
                ['DEPLOY', { GAS_LIMIT: '1' }],
                ['ISSUE', { TICK: 'JDOG.2', MAX_SUPPLY: '1' }],
            ]);
            expect(msg).to.match(/DEPLOY/);
        });
    });
});
