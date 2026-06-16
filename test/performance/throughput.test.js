/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict';

// ─── Performance: SDK hot-path throughput ─────────────────────────────────────
//
// validate() and setNumberFormats() run on every action a dapp builds, often in
// tight loops (batch builders, order books). These are throughput SANITY checks:
// the bounds are deliberately generous (≈50× headroom over observed speed) so
// they never flake on a loaded CI, but they DO catch a catastrophic regression —
// accidental O(n²) work, a sync read, or a per-call network/file hit slipping
// into the hot path. Scale with PERF_ITERATIONS.

const { expect } = require('chai');
const Utility   = require('../../src/utility.js');
const Validator = require('../../src/validator.js');

const ITERATIONS = parseInt(process.env.PERF_ITERATIONS, 10) || 10000;

describe('Performance: SDK hot-path throughput', function () {
  this.timeout(60000);

  it(`validates ${ITERATIONS} ISSUE actions well under the regression ceiling`, function () {
    const v = new Validator(new Utility());
    const action = { TICK: 'PERFTOKEN', DECIMALS: '8', MAX_SUPPLY: '21000000' };

    const start = process.hrtime.bigint();
    for (let i = 0; i < ITERATIONS; i++) {
      const errors = v.validate('ISSUE', action);
      if (!Array.isArray(errors)) throw new Error('validate did not return an array');
    }
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const opsPerSec = Math.round((ITERATIONS / ms) * 1000);
    // eslint-disable-next-line no-console -- performance test intentionally reports throughput to stdout
    console.log(`        validate: ${ITERATIONS} ops in ${ms.toFixed(1)}ms (${opsPerSec.toLocaleString()} ops/s)`);

    // Ceiling: 5s for 10k validations is ~50× slower than observed — a true
    // regression (e.g. per-call I/O) would blow well past it.
    expect(ms, `validate too slow: ${ms.toFixed(1)}ms for ${ITERATIONS}`).to.be.below(5000 * (ITERATIONS / 10000));
  });

  it(`formats ${ITERATIONS} full-precision amounts well under the regression ceiling`, function () {
    const u = new Utility();
    const amounts = ['0.000000000000000001', '21000000000000000000', '1000000.123456789012345678', '0.1'];

    const start = process.hrtime.bigint();
    for (let i = 0; i < ITERATIONS; i++) {
      const out = u.setNumberFormats({ AMOUNT: amounts[i & 3] });
      if (typeof out.AMOUNT !== 'string') throw new Error('setNumberFormats did not preserve a string amount');
    }
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const opsPerSec = Math.round((ITERATIONS / ms) * 1000);
    // eslint-disable-next-line no-console -- performance test intentionally reports throughput to stdout
    console.log(`        setNumberFormats: ${ITERATIONS} ops in ${ms.toFixed(1)}ms (${opsPerSec.toLocaleString()} ops/s)`);

    expect(ms, `setNumberFormats too slow: ${ms.toFixed(1)}ms for ${ITERATIONS}`).to.be.below(8000 * (ITERATIONS / 10000));
  });

  it('validate() throughput does not degrade with repeated reuse of one Validator', function () {
    // A leak/accumulation in the Validator (e.g. an unbounded internal cache)
    // would make later batches progressively slower. Compare first vs last batch.
    const v = new Validator(new Utility());
    const batch = Math.max(1000, Math.floor(ITERATIONS / 5));
    const action = { TICK: 'REUSE', DECIMALS: '8', MAX_SUPPLY: '1000000' };

    function timeBatch() {
      const s = process.hrtime.bigint();
      for (let i = 0; i < batch; i++) v.validate('ISSUE', action);
      return Number(process.hrtime.bigint() - s) / 1e6;
    }

    const first = timeBatch();
    for (let i = 0; i < 3; i++) timeBatch(); // warm/age the instance
    const last = timeBatch();

    // Last batch must not be wildly slower than the first (allow 5× for GC/noise).
    expect(last, `degradation: first=${first.toFixed(1)}ms last=${last.toFixed(1)}ms`).to.be.below(first * 5 + 50);
  });
});
