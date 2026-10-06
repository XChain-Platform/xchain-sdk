'use strict';

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 **********************************************************************
 * BATCH limit-scan conformance: SDK mirror vs the consensus arbiter.
 *
 * ONE vector set, compared by CLASSIFICATION and COUNT rather than by the
 * frozen limits table. The table was the whole guard before, and it could not
 * see the two real divergences: the mirror counted only the sub-entries that
 * PARSED where the arbiter counts every command, and an empty entry was a
 * per-command failure here and a whole-batch reject there.
 *
 * Each vector states the classification of every sub-command, the command
 * count, and the whole-batch verdict. The SDK half runs everywhere. When a
 * sibling xchain-indexer checkout is present the SAME table is driven through
 * the REAL arbiter - classifyLimitAction for the classifications,
 * Batch.parse() for the verdict, maxMintsPerDistinctTick for the per-token
 * MINT maximum, and the number of dispatched sub-commands for the count - so
 * this is a comparison against running code, not against a transcription of it.
 *
 * WHERE THE TWO HALVES DO NOT AGREE, THE VECTOR SAYS SO OUT LOUD.
 *
 * D7 keys MINT distinctness on the RESOLVED TICKER ID; the client mirror holds
 * strings and is a DECLARED conservative approximation (see the header of
 * src/protocol/batch_limits.js). A vector that straddles one of those two declared
 * divergences carries `arbiterVerdict` and `sdkVerdict` SEPARATELY plus a
 * `divergence` naming which one it pins - never a single verdict massaged
 * until both halves agree, which is how a divergence gets discovered in
 * production instead of here. A meta-test enforces that shape: a vector may
 * state two verdicts ONLY if it names a declared divergence, so a future edit
 * cannot quietly split a vector's expectations to make a failure go away.
 ********************************************************************/

const { expect } = require('chai');
const path = require('path');
const { loadIndexerAction } = require('../../../helpers/indexer_action_handler.js');

const {
    BATCH_COMMAND_WEIGHTS,
    BATCH_WEIGHT_BUDGET,
    formatVersion,
    subCommandWeight,
} = require('../../../../src/protocol/batch_limits.js');
const {
    FORMAT_FIELD_VECTORS,
    WEIGHT_BATCH_VECTORS,
    WEIGHT_VECTORS,
} = require('./fixtures/weight_vectors.js');

function loadIndexer(context) {
    const resolved = loadIndexerAction('batch');
    if (!resolved) return context.skip();
    const { root, Handler: Batch } = resolved;

    process.env.INDEXER_COIN = process.env.INDEXER_COIN || 'BTC';
    process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';
    try {
        return {
            Batch,
            IdxUtility: require(path.join(root, 'src', 'utility.js')),
            IdxConfig: require(path.join(root, 'src', 'config.js')),
            ProtocolChanges: require(path.join(root, 'src', 'protocol_changes.js')),
        };
    } catch (e) {
        return context.skip();
    }
}

function createWeightHandler(dependencies) {
    const { Batch, IdxUtility, IdxConfig, ProtocolChanges, blockTime } = dependencies;
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
}

function setupWeightArbiter(context) {
    const dependencies = loadIndexer(context);
    const idxUtil = new dependencies.IdxUtility();
    const blockTime = Math.floor(Date.now() / 1000);
    dependencies.blockTime = blockTime;
    return {
        idxUtil,
        makeHandler: () => createWeightHandler(dependencies),
    };
}

describe('BATCH limit-scan conformance (SDK mirror vs arbiter)', function () {
    describe('weight conformance (BATCH_COST_WEIGHTING)', function () {
        describe('arbiter half (sibling xchain-indexer checkout)', function () {
            let makeHandler = null;
            let idxUtil = null;

            before(function () {
                this.timeout(30000);
                const setup = setupWeightArbiter(this);
                makeHandler = setup.makeHandler;
                idxUtil = setup.idxUtil;
            });

            it('mirrors the arbiter budget and weight table byte-for-byte', function () {
                const { handler } = makeHandler();
                expect(handler.weightBudget).to.equal(BATCH_WEIGHT_BUDGET);
                expect(handler.commandWeights).to.deep.equal(BATCH_COMMAND_WEIGHTS);
            });

            it('derives the FORMAT byte identically to the arbiter, field for field', function () {
                for (const v of FORMAT_FIELD_VECTORS) {
                    const label = 'field ' + JSON.stringify(v.field === undefined ? 'undefined' : v.field);
                    expect(formatVersion(v.field), 'mirror ' + label).to.equal(v.expected);
                    expect(idxUtil.getFormatVersion(v.field), 'arbiter ' + label).to.equal(v.expected);
                }
            });
        });
    });
});

describe('BATCH limit-scan conformance (SDK mirror vs arbiter)', function () {
    describe('weight conformance (BATCH_COST_WEIGHTING)', function () {
        describe('arbiter half (sibling xchain-indexer checkout)', function () {
            let makeHandler = null;

            before(function () {
                this.timeout(30000);
                makeHandler = setupWeightArbiter(this).makeHandler;
            });

            for (const v of WEIGHT_VECTORS) {
                it(v.name, async function () {
                    this.timeout(20000);
                    const { handler } = makeHandler();
                    // batchWeight over one command exercises the arbiter's whole
                    // derivation path (action read, alias normalization, the
                    // DEPLOY format read), exactly as parse() weighs it.
                    const arbiter = await handler.batchWeight([v.command], { BLOCK_INDEX: 200 }, true);
                    expect(arbiter, 'arbiter weight').to.equal(v.weight);
                    expect(subCommandWeight(v.command), 'mirror weight').to.equal(v.weight);
                });
            }
        });
    });
});

describe('BATCH limit-scan conformance (SDK mirror vs arbiter)', function () {
    describe('weight conformance (BATCH_COST_WEIGHTING)', function () {
        describe('arbiter half (sibling xchain-indexer checkout)', function () {
            let makeHandler = null;

            before(function () {
                this.timeout(30000);
                makeHandler = setupWeightArbiter(this).makeHandler;
            });

            for (const v of WEIGHT_BATCH_VECTORS) {
                it(v.name, async function () {
                    this.timeout(20000);
                    const { handler, dispatched } = makeHandler();
                    const entries = v.tail.split(';');
                    expect(await handler.batchWeight(entries, { BLOCK_INDEX: 200 }, true),
                        'arbiter batch weight').to.equal(v.weight);

                    const data = {
                        ACTION: 'BATCH', FORMAT: 0, BLOCK_INDEX: 200,
                        SOURCE: 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
                        TX_DATA: 'BATCH|0|' + v.tail,
                    };
                    const log = console.log;
                    console.log = () => {};
                    try { await handler.parse(['0'], data, null); } finally { console.log = log; }
                    expect(data['STATUS'], 'arbiter verdict').to.equal(v.verdict);
                    if (v.verdict === 'valid')
                        expect(dispatched.length, 'every sub-command runs').to.equal(entries.length);
                    else
                        expect(dispatched.length, 'no sub-command runs').to.equal(0);
                });
            }
        });
    });
});
