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
 * Batch.parse() for the verdict, and the number of dispatched sub-commands for
 * the count - so this is a comparison against running code, not against a
 * transcription of it.
 ********************************************************************/

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const {
    BATCH_COMMAND_LIMIT,
    BATCH_ACTION_LIMITS,
    CHILD_ISSUE_KEY,
    classifyCommand,
    scanBatch,
} = require('../../src/batchLimits.js');

// The arbiter's error vocabulary, so one table can state one expected verdict
// for both halves. 'valid' means no whole-batch rule was broken.
function verdictOf(scan) {
    const v = scan.violation;
    if (!v) return 'valid';
    if (v.kind === 'COMMAND_LIMIT') return 'invalid: COMMAND (limit)';
    if (v.kind === 'ACTION_UNKNOWN') return 'invalid: ACTION (unknown)';
    return 'invalid: ' + v.action + ' (limit)';
}

const repeat = (n, f) => Array.from({ length: n }, (_, i) => f(i));

/*
 * The vector set. `classes` is asserted per sub-command; where a vector is 250
 * commands long the classification is uniform and stated once via `uniform`.
 */
const VECTORS = [
    {
        name: 'undotted TICK is the one top-level slot',
        tail: 'ISSUE|0|JDOG|1000',
        classes: ['ISSUE'], count: 1, verdict: 'valid',
    },
    {
        name: 'dotted child TICK is exempt: parent plus children in one batch',
        tail: 'ISSUE|0|JDOG|1000;ISSUE|0|JDOG.1|1;ISSUE|0|JDOG.2|1',
        classes: ['ISSUE', CHILD_ISSUE_KEY, CHILD_ISSUE_KEY], count: 3, verdict: 'valid',
    },
    {
        name: 'deep-dotted child TICK is exempt too',
        tail: 'ISSUE|0|JDOG.1.2|1;ISSUE|0|JDOG.3.4|1',
        classes: [CHILD_ISSUE_KEY, CHILD_ISSUE_KEY], count: 2, verdict: 'valid',
    },
    {
        name: 'two undotted ISSUEs break the top-level limit',
        tail: 'ISSUE|0|JDOG|1000;ISSUE|0|OTHER|1',
        classes: ['ISSUE', 'ISSUE'], count: 2, verdict: 'invalid: ISSUE (limit)',
    },
    {
        name: 'caret TICK is never exempt (plain)',
        tail: 'ISSUE|0|^12|1;ISSUE|0|^13|1',
        classes: ['ISSUE', 'ISSUE'], count: 2, verdict: 'invalid: ISSUE (limit)',
    },
    {
        name: 'caret TICK is never exempt (dotted: the dot is an id separator)',
        tail: 'ISSUE|0|^12.5|1;ISSUE|0|^13.6|1',
        classes: ['ISSUE', 'ISSUE'], count: 2, verdict: 'invalid: ISSUE (limit)',
    },
    {
        name: 'legacy no-VERSION dotted TICK classifies as a child after the implied VERSION 0',
        tail: 'ISSUE|JDOG.1|1000;ISSUE|JDOG.2|1000;ISSUE|JDOG|1',
        classes: [CHILD_ISSUE_KEY, CHILD_ISSUE_KEY, 'ISSUE'], count: 3, verdict: 'valid',
    },
    {
        name: 'unknown FORMAT still classifies off params[1]',
        tail: 'ISSUE|99|JDOG.1|1;ISSUE|99|JDOG.2|1',
        classes: [CHILD_ISSUE_KEY, CHILD_ISSUE_KEY], count: 2, verdict: 'valid',
    },
    {
        name: 'malformed ISSUE with no TICK counts as top-level',
        tail: 'ISSUE|0;ISSUE|0|JDOG|1',
        classes: ['ISSUE', 'ISSUE'], count: 2, verdict: 'invalid: ISSUE (limit)',
    },
    {
        name: 'an empty entry is a whole-batch reject, not a per-command failure',
        tail: 'ISSUE|0|JDOG|1;;ISSUE|0|JDOG.1|1',
        classes: ['ISSUE', '', CHILD_ISSUE_KEY], count: 3, verdict: 'invalid: ACTION (unknown)',
    },
    {
        name: 'a trailing semicolon is a command and it is empty',
        tail: 'ISSUE|0|JDOG|1;',
        classes: ['ISSUE', ''], count: 2, verdict: 'invalid: ACTION (unknown)',
    },
    {
        name: 'a LOWERCASE action name is unknown, never a second ISSUE',
        tail: 'issue|0|A;issue|0|B',
        classes: ['issue', 'issue'], count: 2, verdict: 'invalid: ACTION (unknown)',
    },
    {
        name: 'aliases expand before classification',
        tail: 'TRANSFER|0|JDOG|1|addr;ISSUE|0|JDOG.1|1',
        classes: ['SEND', CHILD_ISSUE_KEY], count: 2, verdict: 'valid',
    },
    {
        name: 'MINT keeps its limit of 1',
        tail: 'MINT|0|A|1;MINT|0|B|1',
        classes: ['MINT', 'MINT'], count: 2, verdict: 'invalid: MINT (limit)',
    },
    {
        name: 'exactly 250 commands is within the cap',
        tail: repeat(250, (i) => 'ISSUE|0|JDOG.' + i + '|1').join(';'),
        uniform: CHILD_ISSUE_KEY, count: 250, verdict: 'valid',
    },
    {
        name: '251 commands rejects the whole batch',
        tail: repeat(251, (i) => 'ISSUE|0|JDOG.' + i + '|1').join(';'),
        uniform: CHILD_ISSUE_KEY, count: 251, verdict: 'invalid: COMMAND (limit)',
    },
    {
        name: '250 commands plus a trailing semicolon is 251 and over the cap',
        tail: repeat(250, (i) => 'ISSUE|0|JDOG.' + i + '|1').join(';') + ';',
        count: 251, verdict: 'invalid: COMMAND (limit)',
    },
    {
        name: 'the cap outranks the ISSUE limit when a batch breaks both',
        tail: repeat(251, (i) => 'ISSUE|0|T' + i + '|1').join(';'),
        uniform: 'ISSUE', count: 251, verdict: 'invalid: COMMAND (limit)',
    },
];

describe('BATCH limit-scan conformance (SDK mirror vs arbiter)', function () {

    it('pins the two consensus numbers the mirror is built on', function () {
        expect(BATCH_COMMAND_LIMIT).to.equal(250);
        expect(BATCH_ACTION_LIMITS).to.deep.equal({ BATCH: 0, MINT: 1, ISSUE: 1 });
        expect(CHILD_ISSUE_KEY).to.equal('ISSUE.CHILD');
    });

    describe('SDK half', function () {
        for (const v of VECTORS) {
            it(v.name, function () {
                const entries = v.tail.split(';');
                const expected = v.classes || entries.map(() => v.uniform);
                if (expected[0] !== undefined)
                    expect(entries.map(classifyCommand)).to.deep.equal(expected);
                const scan = scanBatch(v.tail);
                expect(scan.count, 'command count').to.equal(v.count);
                expect(verdictOf(scan), 'whole-batch verdict').to.equal(v.verdict);
            });
        }
    });

    /*
     * The arbiter half. Drives the REAL xchain-indexer Batch handler over the
     * same vectors with in-memory stubs: the genuine ProtocolChanges registry
     * (so the activation scan that turns a lowercase or empty ACTION into
     * `invalid: ACTION (unknown)` is the real one) and no-op persistence.
     * ISSUANCE_FEE is forced off, which parks the aggregate gas pre-check: that
     * is a different rule with its own row, and this suite is about
     * classification and counting.
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
                    getTickerId: async () => 1,
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

        for (const v of VECTORS) {
            it(v.name, async function () {
                this.timeout(20000);
                const { handler, dispatched } = makeHandler();
                const entries = v.tail.split(';');
                const expected = v.classes || entries.map(() => v.uniform);
                if (expected[0] !== undefined)
                    expect(entries.map((e) => arbiterClass(handler, e))).to.deep.equal(expected);

                const got = await arbiterVerdict(handler, dispatched, v.tail);
                expect(got.status, 'arbiter verdict').to.equal(v.verdict);
                // A valid batch dispatches one sub-command per counted command:
                // that dispatch count IS the arbiter's count, and it must equal
                // the SDK's. An invalid batch dispatches nothing, and its count
                // is pinned by the cap boundary vectors either side of 250.
                if (v.verdict === 'valid')
                    expect(got.dispatched, 'arbiter command count').to.equal(scanBatch(v.tail).count);
            });
        }
    });
});
