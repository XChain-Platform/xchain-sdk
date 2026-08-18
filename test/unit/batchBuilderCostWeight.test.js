'use strict';

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 **********************************************************************
 * BATCH_COST_WEIGHTING on the COMPOSE side: batchBuilder._validate().
 *
 * The builder counted commands and nothing else, so it composed batches the
 * chain rejects whole: nine EXECUTEs weigh 270 and eleven AIRDROPs weigh 275,
 * and both are nowhere near the 250-command cap the builder was checking. The
 * arbiter has enforced a weighted budget in that position since
 * BATCH_COST_WEIGHTING (genesis-active on testnet and regtest, unarmed on
 * mainnet), and the SDK mirror already carried the table for the DECODE-side
 * sites (decoder/parse.js, preflight/checks/batch.js) - only the builder was
 * left counting.
 *
 * Two halves, deliberately:
 *
 *  - the BUILDER half pins the boundaries, the precedence between the count,
 *    the budget and the per-ACTION caps, and the alias expansion, all against
 *    numbers written out longhand rather than computed from the weight table,
 *    so a retune of a weight reddens here instead of quietly re-deriving its
 *    own expectations;
 *  - the ARBITER half drives the SAME batches through the real
 *    xchain-indexer Batch handler when a sibling checkout is present, so the
 *    claim "the same arithmetic the indexer applies" is a comparison against
 *    running code rather than a transcription of it. It skips clean without
 *    the sibling, the same posture batchLimitsConformance.test.js takes.
 *
 * Every over-budget case is PAIRED with the largest batch that still fits.
 * One test alone cannot tell "the budget stopped it" from "nothing bounds
 * it", which is the lesson this spec's predecessor paid for on chain.
 ********************************************************************/

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const XChainSDK = require('../../src/XChainSDK.js');
const {
    BATCH_COMMAND_LIMIT,
    BATCH_WEIGHT_BUDGET,
    BATCH_COMMAND_WEIGHTS,
    actionWeight,
} = require('../../src/batchLimits.js');

// Queue `entries` ([action, params] pairs) on a fresh builder and return the
// message of whatever _validate() throws, or null when it accepts the batch.
function validateQueue(entries) {
    const sdk = new XChainSDK({ network: 'bitcoin-regtest' });
    const batch = sdk.batch();
    for (const [action, params] of entries) batch.add(action, params || {});
    try {
        batch._validate();
        return null;
    } catch (e) {
        return e.message;
    }
}

// The same queue, as the ';'-joined wire tail the arbiter would weigh. The
// weight scan reads the leading token only, so a minimal body is faithful.
function wireTail(entries) {
    return entries.map(([action]) => action + '|0|x').join(';');
}

const repeat = (n, action, params) => Array.from({ length: n }, () => [action, params || {}]);

/*
 * The vectors both halves run. `weight` is written out longhand on purpose:
 * deriving it from BATCH_COMMAND_WEIGHTS here would make every expectation
 * agree with the table by construction, including a wrong table.
 */
const VECTORS = [
    { name: '8 EXECUTEs weigh 240 and fit',
      queue: repeat(8, 'EXECUTE'),  weight: 240, over: false },
    { name: '9 EXECUTEs weigh 270 and blow the budget on 9 commands',
      queue: repeat(9, 'EXECUTE'),  weight: 270, over: true },
    { name: '10 AIRDROPs weigh 250 and fit exactly',
      queue: repeat(10, 'AIRDROP'), weight: 250, over: false },
    { name: '11 AIRDROPs weigh 275 and blow the budget on 11 commands',
      queue: repeat(11, 'AIRDROP'), weight: 275, over: true },
    { name: 'one DEPLOY may carry 220 companions',
      queue: [['DEPLOY', {}]].concat(repeat(220, 'SEND')), weight: 250, over: false },
    { name: 'one DEPLOY plus 221 companions weighs 251',
      queue: [['DEPLOY', {}]].concat(repeat(221, 'SEND')), weight: 251, over: true },
    { name: '250 ordinary commands weigh 250, the identity case',
      queue: repeat(250, 'SEND'),   weight: 250, over: false },
    { name: 'DROP is an AIRDROP to the weight table, alias and all',
      queue: repeat(11, 'DROP'),    weight: 275, over: true },
];

describe('BATCH_COST_WEIGHTING: batchBuilder enforces the weighted budget', function () {

    describe('builder half', function () {

        it('pins the budget and the weights the builder composes against', function () {
            expect(BATCH_WEIGHT_BUDGET).to.equal(250);
            expect(BATCH_COMMAND_WEIGHTS).to.deep.equal({
                AIRDROP: 25, DIVIDEND: 25, DEPLOY: 30, EXECUTE: 30, XEXEC: 30,
            });
            // The invariant the count pre-filter rests on: every weight is an
            // integer >= 1, so a batch over the count is over the budget too.
            for (const action of Object.keys(BATCH_COMMAND_WEIGHTS)) {
                expect(Number.isInteger(actionWeight(action)), action).to.equal(true);
                expect(actionWeight(action), action).to.be.at.least(1);
            }
            expect(actionWeight('SEND'), 'an unweighted action is the default 1').to.equal(1);
        });

        for (const v of VECTORS) {
            it(v.name, function () {
                const message = validateQueue(v.queue);
                if (!v.over) {
                    expect(message, 'accepted').to.equal(null);
                    return;
                }
                expect(message, 'refused').to.be.a('string');
                expect(message).to.match(new RegExp('weigh ' + v.weight + '\\b'));
                expect(message).to.match(new RegExp(String(BATCH_WEIGHT_BUDGET)));
            });
        }

        it('reports the COUNT, not the weight, when both bounds are broken', function () {
            // 251 SENDs weigh 251 and count 251. The count runs first on chain,
            // so the composer is told the same thing the chain would say.
            const message = validateQueue(repeat(BATCH_COMMAND_LIMIT + 1, 'SEND'));
            expect(message).to.match(/at most 250 commands/);
            expect(message).to.not.match(/weigh/);
        });

        it('reports the budget BEFORE a per-ACTION cap, as the arbiter does', function () {
            // 9 EXECUTEs (270) plus two top-level ISSUEs (2). Both the budget
            // and the ISSUE cap are broken; the budget is checked first.
            const both = validateQueue(repeat(9, 'EXECUTE')
                .concat([['ISSUE', { TICK: 'AAA' }], ['ISSUE', { TICK: 'BBB' }]]));
            expect(both).to.match(/weigh 272\b/);

            // The control, without which the test above cannot tell "the budget
            // won the race" from "the ISSUE cap never fires here anyway".
            const capOnly = validateQueue([['ISSUE', { TICK: 'AAA' }], ['ISSUE', { TICK: 'BBB' }]]);
            expect(capOnly).to.match(/at most 1 top-level ISSUE/);
        });

        it('leaves the DEPLOY cap an independent rule beside the weight', function () {
            // Two DEPLOYs weigh 60, far inside the budget, so the verdict still
            // comes from the cap - the compose-side twin of the arbiter's A3,
            // which requires that error string not to move.
            const message = validateQueue(repeat(2, 'DEPLOY'));
            expect(message).to.match(/at most 1 DEPLOY/);
        });

        it('still refuses an empty batch first of all', function () {
            expect(validateQueue([])).to.match(/at least one action/);
        });
    });

    /*
     * The arbiter half. Same vectors, driven through the real handler: its
     * weight table, its `batchWeight` arithmetic, and one full `parse()`
     * verdict so the over-budget case is pinned as the whole-batch rejection
     * it really is, not merely as a number.
     */
    describe('arbiter half (sibling xchain-indexer checkout)', function () {
        let makeHandler = null;

        before(function () {
            this.timeout(30000);
            const roots = [process.env.XCHAIN_INDEXER_PATH,
                path.join(__dirname, '..', '..', '..', 'xchain-indexer')].filter(Boolean);
            const root = roots.find((r) => fs.existsSync(path.join(r, 'src', 'actions', 'batch.js')));
            if (!root) return this.skip();

            process.env.INDEXER_COIN = process.env.INDEXER_COIN || 'BTC';
            process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';
            let Batch, IdxUtility, IdxConfig, ProtocolChanges;
            try {
                Batch = require(path.join(root, 'src', 'actions', 'batch.js'));
                IdxUtility = require(path.join(root, 'src', 'utility.js'));
                IdxConfig = require(path.join(root, 'src', 'config.js'));
                ProtocolChanges = require(path.join(root, 'src', 'protocol_changes.js'));
            } catch (e) {
                return this.skip();
            }

            const blockTime = Math.floor(Date.now() / 1000);
            makeHandler = function () {
                const util = new IdxUtility();
                const config = typeof IdxConfig.getConfig === 'function' ? IdxConfig.getConfig() : IdxConfig;
                const decoderDb = { getBlockTime: async () => blockTime };
                const indexerDb = {
                    createBatch: async () => {},
                    createActionIndex: async () => 1,
                    isActionAllowed: async () => true,
                    getTokenInfo: async () => null,
                    getAddressBalances: async () => [],
                    getTickerId: async () => null,
                    suppressIndexIdCreation: false,
                };
                const changes = new ProtocolChanges({ config, util, decoderDb, indexerDb });
                const dispatched = [];
                const handler = new Batch({
                    config, util, decoderDb, indexerDb,
                    mapper: { createMappings: async () => {} },
                    protocolChanges: {
                        isEnabled: async (name, blockIndex) =>
                            (name === 'ISSUANCE_FEE' ? false : changes.isEnabled(name, blockIndex)),
                    },
                    processAction: async (action) => { dispatched.push(action); },
                    actionAliases: { TRANSFER: 'SEND', ADDR: 'ADDRESS', DROP: 'AIRDROP', CAST: 'BROADCAST', MSG: 'MESSAGE' },
                });
                return { handler, dispatched };
            };
        });

        it('mirrors the arbiter budget and weight table byte-for-byte', function () {
            const { handler } = makeHandler();
            expect(handler.weightBudget).to.equal(BATCH_WEIGHT_BUDGET);
            expect(handler.commandWeights).to.deep.equal(BATCH_COMMAND_WEIGHTS);
        });

        for (const v of VECTORS) {
            it('weighs the same as the arbiter: ' + v.name, async function () {
                this.timeout(20000);
                const { handler } = makeHandler();
                const commands = wireTail(v.queue).split(';');
                const data = { ACTION: 'BATCH', FORMAT: 0, BLOCK_INDEX: 200 };
                // The arbiter's own arithmetic, normalized exactly as parse()
                // normalizes before weighing (so DROP weighs an AIRDROP there
                // too), against the builder's compose-time sum.
                const arbiter = await handler.batchWeight(commands, data, true);
                const builder = v.queue.reduce((sum, [action]) => sum + actionWeight(action), 0);
                expect(arbiter, 'arbiter weight').to.equal(v.weight);
                expect(builder, 'builder weight').to.equal(v.weight);
            });
        }

        it('rejects the over-budget batch whole, with the string the SDK composes against', async function () {
            this.timeout(20000);
            const { handler, dispatched } = makeHandler();
            const data = {
                ACTION: 'BATCH', FORMAT: 0, BLOCK_INDEX: 200,
                SOURCE: 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
                TX_DATA: 'BATCH|0|' + wireTail(repeat(9, 'EXECUTE')),
            };
            const log = console.log;
            console.log = () => {};
            try { await handler.parse(['0'], data, null); } finally { console.log = log; }
            expect(data['STATUS']).to.equal('invalid: COMMAND (limit)');
            expect(dispatched.length, 'no sub-command runs').to.equal(0);
        });
    });
});
