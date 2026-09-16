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
const fs = require('fs');
const path = require('path');

const {
    BATCH_ACTION_LIMITS,
    BATCH_ACTION_LIMITS_ACTIVE,
    BATCH_COMMAND_LIMIT,
    BATCH_GATED_ACTION_LIMITS,
    CHILD_ISSUE_KEY,
} = require('../../../../src/protocol/batch_limits.js');
const { CANONICAL_CARET_ID } = require('../../../../src/preflight/constants.js');
const { arbiterVerdictOf } = require('./support/limit_helpers.js');
const { VECTORS } = require('./fixtures/limit_vectors.js');

/*
 * Ticker names the arbiter half's stub database knows about, and the ids they
 * resolve to. These are load-bearing, not decoration: D7 buckets MINTs by
 * RESOLVED ID, so a stub that answers every lookup with one id collapses every
 * MINT into a single bucket and makes the distinctness vectors pass without
 * testing anything (that is exactly what `getTickerId: async () => 1` did
 * here, and it is why the old 'MINT keeps its limit of 1' vector looked green).
 *
 * JDOG is spelled 614 on purpose: the caret-alias vectors need a name and a
 * `^<id>` that really are ONE token.
 */
const TICKER_IDS = new Map([
    ['jdog',  614],
    ['other', 615],
    ['pepe',  700],
    ['doge',  701],
]);
const EXISTING_TICKER_IDS = new Set(TICKER_IDS.values());

function loadIndexer(context) {
    const roots = [process.env.XCHAIN_INDEXER_PATH,
        path.join(__dirname, '../..', '..', '..', '..', 'xchain-indexer')].filter(Boolean);
    const root = roots.find((r) => fs.existsSync(path.join(r, 'src', 'actions', 'batch.js')));
    if (!root) return context.skip();

    process.env.INDEXER_COIN = process.env.INDEXER_COIN || 'BTC';
    process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';
    try {
        return {
            Batch: require(path.join(root, 'src', 'actions', 'batch.js')),
            IdxUtility: require(path.join(root, 'src', 'utility.js')),
            IdxConfig: require(path.join(root, 'src', 'config.js')),
            ProtocolChanges: require(path.join(root, 'src', 'protocol_changes.js')),
        };
    } catch (e) {
        return context.skip();
    }
}

// Mirror of xchain-indexer/src/db/index_tables.js getTickerId, over the fixed
// token set above: a CANONICAL `^<id>` resolves straight to that id
// and only when a row backs it (a dangling caret is null, never a
// phantom id), a name resolves case-insensitively, and anything
// unknown - including a non-canonical caret, which falls through to
// the name lookup as a literal string - is null.
//
// The rule is READ from src/preflight/constants.js rather than re-inlined
// here: that constant is the SDK's single mirror of the indexer literal, and
// checkRegexMirrors in bin/check-preflight-drift.js binds it to db.js by
// value. A third local copy could disagree with both and nothing would see it.
async function getTickerId(tick) {
    const str = String(tick);
    const pid = str.substring(1);
    if (str.charAt(0) === '^' && CANONICAL_CARET_ID.test(pid))
        return EXISTING_TICKER_IDS.has(Number(pid)) ? Number(pid) : null;
    const hit = TICKER_IDS.get(str.toLowerCase());
    return hit === undefined ? null : hit;
}

// `off` lists flags forced inactive for this handler, so one vector
// set can also be driven BELOW a flag day.
function createLimitHandler(dependencies, off) {
    const { Batch, IdxUtility, IdxConfig, ProtocolChanges, blockTime } = dependencies;
    const disabled = off || ['ISSUANCE_FEE'];
    const util = new IdxUtility();
    const config = typeof IdxConfig.getConfig === 'function' ? IdxConfig.getConfig() : IdxConfig;
    const decoderDb = { getBlockTime: async () => blockTime };
    const indexerDb = {
        createBatch: async () => {},
        createActionIndex: async () => 1,
        isActionAllowed: async () => true,
        getTokenInfo: async () => null,
        getAddressBalances: async () => [],
        getTickerId,
        suppressIndexIdCreation: false,
    };
    const changes = new ProtocolChanges({ config, util, decoderDb, indexerDb });
    const dispatched = [];
    const handler = new Batch({
        config, util, decoderDb, indexerDb,
        mapper: { createMappings: async () => {} },
        protocolChanges: {
            isEnabled: async (name, blockIndex) =>
                (disabled.includes(name) ? false : changes.isEnabled(name, blockIndex)),
        },
        processAction: async (action) => { dispatched.push(action); },
        actionAliases: { TRANSFER: 'SEND', ADDR: 'ADDRESS', DROP: 'AIRDROP', CAST: 'BROADCAST', MSG: 'MESSAGE' },
    });
    return { handler, dispatched };
}

function setupLimitArbiter(context) {
    const dependencies = loadIndexer(context);
    const blockTime = Math.floor(Date.now() / 1000);
    dependencies.blockTime = blockTime;
    return (off) => createLimitHandler(dependencies, off);
}

// The arbiter reads the leading token, alias-expands it, THEN classifies;
// reproduce that call shape rather than a convenience wrapper.
function arbiterClass(handler, command) {
    const action = handler.normalizeSubAction(String(command).split('|')[0]);
    return handler.classifyLimitAction(action, command, true);
}

async function arbiterVerdict(handler, dispatched, tail) {
    const data = {
        ACTION: 'BATCH', FORMAT: 0, BLOCK_INDEX: 200,
        SOURCE: 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
        TX_DATA: 'BATCH|0|' + tail,
    };
    // The handler narrates every sub-command to stdout; a 250-command
    // vector would bury the reporter.
    const log = console.log;
    console.log = () => {};
    try { await handler.parse(['0'], data, null); } finally { console.log = log; }
    return { status: data['STATUS'], dispatched: dispatched.length };
}

/*
 * The arbiter half. Drives the REAL xchain-indexer Batch handler over the
 * same vectors with in-memory stubs: the genuine ProtocolChanges registry
 * (so the activation scan that turns a lowercase or empty ACTION into
 * `invalid: ACTION (unknown)` is the real one) and no-op persistence.
 * ISSUANCE_FEE is forced off, which parks the aggregate gas pre-check: that
 * is a different rule with its own row, and this suite is about
 * classification and counting.
 *
 * getTickerId is a REAL resolver over a fixed name->id map, not a constant.
 * D7 buckets MINTs by resolved id, so a constant resolver makes every MINT
 * one token and every distinctness vector vacuous.
 */
describe('BATCH limit-scan conformance (SDK mirror vs arbiter)', function () {
    describe('arbiter half (sibling xchain-indexer checkout)', function () {
        let makeHandler = null;

        before(function () {
            this.timeout(30000);
            makeHandler = setupLimitArbiter(this);
        });

        it('mirrors the arbiter limit tables byte-for-byte, ungated and gated apart', function () {
            const { handler } = makeHandler();
            expect(handler.commandLimit).to.equal(BATCH_COMMAND_LIMIT);
            expect(handler.actionLimits).to.deep.equal(BATCH_ACTION_LIMITS);
            expect(handler.gatedActionLimits).to.deep.equal(BATCH_GATED_ACTION_LIMITS);
            // The merge the arbiter performs at/after the flag is exactly what
            // the mirror enforces unconditionally, so an edit to EITHER arbiter
            // table reddens here rather than at a flag day.
            expect(Object.assign({}, handler.actionLimits, handler.gatedActionLimits))
                .to.deep.equal(BATCH_ACTION_LIMITS_ACTIVE);
            expect(handler.childIssueKey).to.equal(CHILD_ISSUE_KEY);
            expect(typeof handler.unresolvedTickKey).to.equal('symbol');
        });

        it('leaves DEPLOY uncapped BELOW the flag, which is why the tables are kept apart', async function () {
            this.timeout(20000);
            const { handler, dispatched } = makeHandler(['ISSUANCE_FEE', 'BATCH_ISSUANCE_LIMITS']);
            const tail = 'DEPLOY|0|600160005260206000f3;DEPLOY|0|600260005260206000f3';
            const got = await arbiterVerdict(handler, dispatched, tail);
            expect(got.status, 'pre-flag verdict').to.equal('valid');
            expect(got.dispatched, 'both DEPLOYs run below the flag').to.equal(2);
        });
    });
});

describe('BATCH limit-scan conformance (SDK mirror vs arbiter)', function () {
    describe('arbiter half (sibling xchain-indexer checkout)', function () {
        let makeHandler = null;

        before(function () {
            this.timeout(30000);
            makeHandler = setupLimitArbiter(this);
        });

        for (const v of VECTORS) {
            it(v.name, async function () {
                this.timeout(20000);
                const { handler, dispatched } = makeHandler();
                const entries = v.tail.split(';');
                const expected = v.classes || entries.map(() => v.uniform);
                if (expected[0] !== undefined)
                    expect(entries.map((e) => arbiterClass(handler, e))).to.deep.equal(expected);

                // The arbiter's own per-token MINT maximum, over RESOLVED ids,
                // read from the same helper parse() substitutes for the raw
                // count. Where this differs from the mirror's `mintMax` the
                // divergence is stated as a NUMBER, not inferred from an error
                // string.
                if (v.arbiterMintMax !== undefined) {
                    const ticks = entries
                        .filter((e) => arbiterClass(handler, e) === 'MINT')
                        .map((e) => handler.subCommandTick('MINT', e, true));
                    expect(await handler.maxMintsPerDistinctTick(ticks),
                        'arbiter per-distinct-token MINT maximum').to.equal(v.arbiterMintMax);
                }

                const got = await arbiterVerdict(handler, dispatched, v.tail);
                expect(got.status, 'arbiter verdict').to.equal(arbiterVerdictOf(v));
                // A valid batch dispatches one sub-command per counted command:
                // that dispatch count IS the arbiter's count, and it must equal
                // the count the vector states, which the SDK half asserts the
                // raw ';'-split against. An invalid batch dispatches nothing,
                // and its count is pinned by the cap vectors either side of 250.
                if (arbiterVerdictOf(v) === 'valid')
                    expect(got.dispatched, 'arbiter command count').to.equal(v.count);
            });
        }
    });
});
