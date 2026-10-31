'use strict';

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 **********************************************************************
 * Duration-fee conformance: projectDurationFee against the indexer's own
 * getUnifiedDurationFee, both run for real over boundary vectors.
 *
 * The SDK projection is a copy of the chain's format-0 duration arithmetic and
 * feeds an error-severity balance verdict. The drift gate pins only handler
 * files under src/actions/, so nothing else would see a change to the day
 * rounding, the free window or the day basis. Running both real functions
 * (not a restatement of the formula) also catches a rounding change inside
 * either side's bc* helpers. Without a sibling checkout the suite skips, and
 * it fails under XCHAIN_REQUIRE_SIBLINGS=1.
 ********************************************************************/

const { expect } = require('chai');
const { loadBatchArbiter } = require('../../../helpers/indexer_action_handler.js');
const { projectDurationFee, gasConfig } = require('../../../../src/preflight/checks/batch/fee_projection.js');
const numeric = require('../../../../src/preflight/numeric.js');

const T0 = 1800000000;
const DAY = 86400;
const DAYS = [0, 1, 89, 90, 91, 92, 180, 365, 3650];
const OFFSETS = [0, Math.round(0.4 * DAY), 43199, 43200, 43201, Math.round(0.6 * DAY), 86399];

// Compare decimal values: the indexer answers 0 or a mathjs BigNumber, the SDK a minimal string.
const value = (x) => numeric.add(String(x), '0');

function expirations() {
    const out = [T0, T0 - DAY];
    for (const d of DAYS) for (const s of OFFSETS) out.push(T0 + d * DAY + s);
    for (let e = T0 + 85 * DAY; e <= T0 + 95 * DAY; e += 3600) out.push(e);
    return out;
}

describe('duration fee: SDK projection vs the indexer arbiter', function () {
    let idxUtil;
    let gas;
    const sdkFee = (e, nowMs = T0 * 1000) =>
        value(projectDurationFee({ version: '0', params: { EXPIRATION: String(e) } }, gas, nowMs).amount);
    const idxFee = (e) => value(idxUtil.getUnifiedDurationFee(String(e), T0, 'EXPIRATION_PER_DAY').fee);

    before(function () {
        const deps = loadBatchArbiter(this, 'the duration-fee indexer parity check');
        if (!deps) return;
        idxUtil = new deps.IdxUtility();
        gas = gasConfig({ config: { network: 'bitcoin-regtest' } });
        expect(gas, 'SDK gas config for bitcoin-regtest').to.not.equal(null);
    });

    it('reads the same free window, per-day gas and gas price as the indexer', function () {
        expect(gas.freeDays).to.equal(idxUtil.config.UNIFIED_EXPIRATION_FEE_FREE_DAYS || 90);
        expect(String(gas.schedule.EXPIRATION_PER_DAY)).to.equal(String(idxUtil.config.GAS_SCHEDULE.EXPIRATION_PER_DAY));
        expect(String(gas.gasPrice)).to.equal(String(idxUtil.config.GAS_PRICE));
    });

    it('prices every boundary and sweep vector exactly as getUnifiedDurationFee does', function () {
        let positive = 0;
        for (const e of expirations()) {
            const want = idxFee(e);
            expect(sdkFee(e), 'EXPIRATION ' + e).to.equal(want);
            if (numeric.isPositive(want)) positive += 1;
        }
        expect(positive, 'vectors with a chargeable fee').to.be.above(0);
    });

    it('rounds the day count to nearest at the free-window edge on both sides', function () {
        const edge = T0 + 90 * DAY + 43200;
        expect(idxFee(edge - 1)).to.equal('0');
        expect(sdkFee(edge - 1)).to.equal('0');
        expect(numeric.isPositive(idxFee(edge))).to.equal(true);
        expect(sdkFee(edge)).to.equal(idxFee(edge));
    });

    it('floors the wall clock to the block-time second', function () {
        const e = T0 + 120 * DAY + 43200;
        expect(sdkFee(e, T0 * 1000 + 999)).to.equal(sdkFee(e, T0 * 1000));
    });
});
