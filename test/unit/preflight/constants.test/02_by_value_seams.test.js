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
const fs = require('fs');
const os = require('os');
const path = require('path');
const constants = require('../../../../src/preflight/constants.js');
const { checkFeeQuoteSeam, checkConfigConstants, checkGasSchedules } = require('../../../../bin/check-preflight-drift.js');

const sdkCoin = (c) => path.join(__dirname, '..', '..', '..', '..', 'src', 'coins', c + '.js');

function buildFakeIndexer(feeCallers, { exempt, gasOverrides, callers, maxRefills }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-gate-'));
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
    fs.writeFileSync(path.join(root, 'src', 'actions', 'index.js'),
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

function registerFeeQuoteTests(fakeIndexer, feeCallers) {
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
}

function registerConfigAndGasTests(fakeIndexer) {
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
        fs.writeFileSync(path.join(r, 'src', 'coins', 'LTC.js'), 'module.exports = {};\n');
        expect(checkGasSchedules(r)).to.equal(1);
    });
}

function registerByValueTests() {
    // The gate's two by-VALUE seams, driven against SYNTHETIC fixtures so the
    // suite stays hermetic (the live sibling is a moving target, per the note above).
    describe('by-value seams', function () {
        let root;
        // The handler basenames a passing fixture must carry, derived from the SDK list
        // rather than typed out again: the gate reads the fee-charging set off the
        // indexer's createFeesObject call sites, while DEPLOY/EXECUTE use the gas schedule.
        const feeCallers = constants.FEE_CHARGING_ACTIONS
            .filter((a) => a !== 'DEPLOY' && a !== 'EXECUTE')
            .map((a) => a.toLowerCase());
        const fakeIndexer = (options) => {
            root = buildFakeIndexer(feeCallers, options);
            return root;
        };

        afterEach(function () {
            if (root) fs.rmSync(root, { recursive: true, force: true });
            root = null;
        });

        registerFeeQuoteTests(fakeIndexer, feeCallers);
        registerConfigAndGasTests(fakeIndexer);
    });
}

describe('pre-flight constants + registry', function () {
    describe('drift map (§8.5)', function () {
        registerByValueTests();
    });
});
