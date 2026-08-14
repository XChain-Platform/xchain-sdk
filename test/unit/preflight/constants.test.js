'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Registry + drift-gate suite (spec §8.5, §8.7). Every quantified
// constant and finding code lives in one module; the certified list
// is the single source (§4.4 error column == this list). The drift
// gate runs here so `npm test` exercises it when a sibling indexer
// checkout is present.

const { expect } = require('chai');
const path = require('path');
const constants = require('../../../src/preflight/constants.js');

describe('pre-flight constants + registry', function () {

    it('every quantified constant is exported (no literals in code)', function () {
        expect(constants.DEFAULT_TIMEOUT_MS).to.equal(4000);
        expect(constants.RECHECK_TIMEOUT_MS).to.equal(2000);
        expect(constants.STALENESS_MS).to.equal(30000);
        expect(constants.ENDPOINT_MEMO_TTL_MS).to.equal(2000);
        expect(constants.REPORT_SCHEMA_VERSION).to.equal(1);
        expect(constants.ENCODING_LIMITS).to.deep.equal({ OP_RETURN: 76, MULTISIGN: 60, P2SH: 476, P2WSH: 476 });
    });

    it('the certified Tier-2 error list is the single source', function () {
        // Every certified code exists in the finding registry, and each
        // is classified local (non-overridable) or network (overridable).
        for (const [code, cls] of Object.entries(constants.TIER2_ERROR_CAPABLE)) {
            expect(constants.FINDING_CODES[code], code + ' missing from FINDING_CODES').to.equal(code);
            expect(['local', 'network']).to.include(cls);
        }
    });

    it('TIER1_DENYLIST mirrors the indexer VM denylist', function () {
        expect(constants.TIER1_DENYLIST).to.deep.equal(['DEPLOY', 'EXECUTE', 'XEXEC', 'BATCH']);
    });

    it('TIER1_SUBCOMMAND_PREFLIGHT is a SUBSET of the denylist, not a replacement for it', function () {
        // The exception list only ever relaxes the short-circuit for something the
        // denylist already names; an entry outside it would be meaningless (that
        // action was never short-circuited) and would read as a second denylist.
        expect(constants.TIER1_SUBCOMMAND_PREFLIGHT).to.deep.equal(['BATCH']);
        for (const a of constants.TIER1_SUBCOMMAND_PREFLIGHT)
            expect(constants.TIER1_DENYLIST, a + ' must be on the denylist it excepts').to.include(a);
    });

    it('the VM-compute actions are NOT exceptable', function () {
        // The denylist exists to keep an unauthenticated caller from running the VM
        // under the block-loop mutex. BATCH is exceptable only because the arbiter
        // refuses its VM sub-actions itself; DEPLOY/EXECUTE/XEXEC ARE the VM, so
        // adding one here would hand out that primitive directly.
        for (const a of ['DEPLOY', 'EXECUTE', 'XEXEC'])
            expect(constants.TIER1_SUBCOMMAND_PREFLIGHT, a).to.not.include(a);
    });

    describe('drift map (§8.5)', function () {
        // The SDK unit suite is hermetic: it must NOT compare INDEXER-MAP.md
        // hashes against the live xchain-indexer sibling, which a second coder
        // edits independently (a moving target would break this suite on every
        // unrelated handler change). The live-hash comparison lives in the
        // standalone bin/check-preflight-drift.js, run by the indexer's own CI
        // (spec §8.5: "CI on xchain-indexer"). Here we only assert the map is
        // well-formed so a malformed/empty map is still caught.
        it('INDEXER-MAP.md parses into well-formed rows', function () {
            const { parseMap } = require('../../../bin/check-preflight-drift.js');
            const rows = parseMap(path.join(__dirname, '..', '..', '..', 'src', 'preflight', 'INDEXER-MAP.md'));
            expect(rows.length, 'map has mapping rows').to.be.greaterThan(0);
            for (const { handler, hash } of rows) {
                expect(handler).to.match(/^src\/actions\/[\w-]+\.js$/);
                expect(hash, handler + ' hash must be 64-hex').to.match(/^[0-9a-f]{64}$/);
            }
        });

        // The gate's two by-VALUE seams, driven against SYNTHETIC fixtures so the
        // suite stays hermetic (the live sibling is a moving target, per the note above).
        describe('by-value seams', function () {
            const fs = require('fs');
            const os = require('os');
            const { checkFeeQuoteSeam, checkConfigConstants, checkGasSchedules } = require('../../../bin/check-preflight-drift.js');

            let root;
            const sdkCoin = (c) => path.join(__dirname, '..', '..', '..', 'src', 'coins', c + '.js');

            // The handler basenames a passing fixture must carry, derived from the SDK list
            // rather than typed out again: the gate now reads the fee-charging set off the
            // indexer's createFeesObject call sites, and DEPLOY/EXECUTE charge off the gas
            // schedule instead, so they have no handler here.
            const feeCallers = constants.FEE_CHARGING_ACTIONS
                .filter((a) => a !== 'DEPLOY' && a !== 'EXECUTE')
                .map((a) => a.toLowerCase());

            function fakeIndexer({ exempt, gasOverrides, callers, maxRefills }) {
                root = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-gate-'));
                fs.mkdirSync(path.join(root, 'src', 'coins'), { recursive: true });
                fs.mkdirSync(path.join(root, 'src', 'actions'), { recursive: true });
                for (const name of (callers || feeCallers)) {
                    fs.writeFileSync(path.join(root, 'src', 'actions', name + '.js'),
                        'let fees = await this.util.createFeesObject(this.indexerDb, data, preferences);\n');
                }
                // A handler that charges nothing, so the walk is proven to select rather than
                // to sweep the directory.
                fs.writeFileSync(path.join(root, 'src', 'actions', 'send.js'),
                    '// createFeesObject is named here in prose only; SEND charges no protocol fee.\n');
                fs.writeFileSync(path.join(root, 'src', 'config.js'),
                    "config['MAX_REFILLS'] = " + (maxRefills === undefined ? constants.MAX_REFILLS : maxRefills) + ';\n');
                fs.writeFileSync(path.join(root, 'src', 'actions.js'),
                    "const FEE_QUOTE_DENYLIST = new Set(['DEPLOY', 'EXECUTE', 'XEXEC', 'BATCH']);\n"
                    + "const FEE_QUOTE_STATIC = new Set(['DEPLOY', 'EXECUTE']);\n"
                    + 'const FEE_QUOTE_EXEMPT = new Set([' + exempt.map((a) => "'" + a + "'").join(', ') + ']);\n');
                for (const c of ['BTC', 'LTC', 'DOGE']) {
                    const real = require(sdkCoin(c));
                    const schedule = Object.assign({}, real.GAS_SCHEDULE, (gasOverrides || {})[c] || {});
                    fs.writeFileSync(path.join(root, 'src', 'coins', c + '.js'),
                        'module.exports = { GAS_SCHEDULE: ' + JSON.stringify(schedule) + ' };\n');
                }
                return root;
            }

            afterEach(function () {
                if (root) fs.rmSync(root, { recursive: true, force: true });
                root = null;
            });

            it('passes when the fixtures agree with the SDK', function () {
                const r = fakeIndexer({ exempt: ['COINPAY', 'DISPENSE'] });
                expect(checkFeeQuoteSeam(r)).to.equal(0);
                expect(checkConfigConstants(r)).to.equal(0);
                expect(checkGasSchedules(r)).to.equal(0);
            });

            // The direction the BET omission actually took. An indexer handler
            // charges a fee and the SDK list does not know, so NATIVE_FEE_FORFEIT is withheld.
            it('fails when a fee-charging handler is missing from FEE_CHARGING_ACTIONS', function () {
                const r = fakeIndexer({ exempt: ['COINPAY'], callers: feeCallers.filter((c) => c !== 'bet') });
                expect(checkFeeQuoteSeam(r)).to.equal(1);
            });

            it('fails when FEE_CHARGING_ACTIONS lists an action no handler charges for', function () {
                const r = fakeIndexer({ exempt: ['COINPAY'], callers: feeCallers.concat('coinpay') });
                expect(checkFeeQuoteSeam(r)).to.equal(1);
            });

            it('fails CLOSED when the call-site walk finds no caller at all', function () {
                const r = fakeIndexer({ exempt: ['COINPAY'], callers: [] });
                // "found none" must never read as "nothing charges a fee"; it throws, and
                // main() reports the throw as a gate failure.
                expect(() => checkFeeQuoteSeam(r)).to.throw(/createFeesObject/);
            });

            // The cap lives in indexer config.js, which no mapped handler hash
            // covers, because dispenser.js only reads it by symbol.
            it('fails when MAX_REFILLS drifts from the indexer config value', function () {
                const r = fakeIndexer({ exempt: ['COINPAY'], maxRefills: constants.MAX_REFILLS + 1 });
                expect(checkConfigConstants(r)).to.equal(1);
            });

            it('fails CLOSED when the indexer MAX_REFILLS literal cannot be read exactly once', function () {
                const r = fakeIndexer({ exempt: ['COINPAY'] });
                fs.writeFileSync(path.join(r, 'src', 'config.js'), '// the cap moved somewhere else\n');
                expect(() => checkConfigConstants(r)).to.throw(/exactly one/);
            });

            it('fails when an action is both indexer-EXEMPT and SDK fee-charging', function () {
                // The exact BET-forfeiture shape, inverted: a forfeiture warning for an action
                // that charges nothing. BET is in FEE_CHARGING_ACTIONS.
                const r = fakeIndexer({ exempt: ['COINPAY', 'BET'] });
                expect(checkFeeQuoteSeam(r)).to.equal(1);
            });

            it('fails when a coin GAS_SCHEDULE value drifts', function () {
                const r = fakeIndexer({ exempt: ['COINPAY'], gasOverrides: { DOGE: { VM_STATE_WRITE: 999999 } } });
                expect(checkGasSchedules(r)).to.equal(1);
            });

            it('fails CLOSED when a coin module carries no GAS_SCHEDULE at all', function () {
                const r = fakeIndexer({ exempt: ['COINPAY'] });
                require('fs').writeFileSync(path.join(r, 'src', 'coins', 'LTC.js'), 'module.exports = {};\n');
                expect(checkGasSchedules(r)).to.equal(1);
            });
        });

        it('every checks/ action module is mapped (or intentionally misc-only)', function () {
            // Guard against adding a certified check without a drift-map entry.
            const { parseMap } = require('../../../bin/check-preflight-drift.js');
            const mapped = new Set(parseMap(path.join(__dirname, '..', '..', '..', 'src', 'preflight', 'INDEXER-MAP.md'))
                .map((r) => r.handler.replace('src/actions/', '').replace('.js', '')));
            // The action groups whose checks carry certified error-capable logic.
            for (const h of ['send', 'destroy', 'mint', 'issue', 'dispenser', 'dispense', 'order', 'swap', 'airdrop', 'dividend', 'batch']) {
                expect(mapped.has(h), `${h} handler should be in INDEXER-MAP.md`).to.equal(true);
            }
        });
    });
});
