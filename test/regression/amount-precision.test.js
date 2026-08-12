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

// Regression: amount full-precision in setNumberFormats (fe9161e)
//
// Commit fe9161e ("preserve full precision for divisible (18-dp) amounts").
// setNumberFormats casts NUMBER_FIELDS to their wire form. The bug was using
// bcnum's parseFloat/parseInt path, which (a) truncates amounts beyond 2^53,
// (b) loses precision past 15-16 significant digits, and (c) emits SCIENTIFIC
// notation (e.g. "1e-18"): each of which corrupts the on-chain ACTION string
// the indexer reads back byte-for-byte. The fix formats via a full-precision
// mathjs bignumber with fixed notation. These pin that exact-wire behaviour, and
// the companion guard that non-numeric values in numeric-NAMED fields (e.g. TYPE
// = "text/plain" on FILE) are left untouched rather than cast to NaN.

const { expect } = require('chai');
const crypto = require('crypto');
const Utility = require('../../src/utility.js');

function u() { return new Utility(); }
function fmtAmount(value) { return u().setNumberFormats({ AMOUNT: value }).AMOUNT; }

describe('Regression (fe9161e): amount full-precision wire formatting', function () {

  it('preserves an 18-decimal divisible amount exactly (no truncation, no 1e-18)', function () {
    const out = fmtAmount('0.000000000000000001');
    expect(out).to.equal('0.000000000000000001');
    expect(/e/i.test(out), 'scientific notation leaked').to.equal(false);
  });

  it('preserves a supply above 2^53 exactly (JS double would truncate)', function () {
    // 2^53 + 1 = 9007199254740993; a double rounds this to ...992.
    expect(fmtAmount('9007199254740993')).to.equal('9007199254740993');
    expect(fmtAmount('21000000000000000000')).to.equal('21000000000000000000');
  });

  it('preserves a large integer part WITH 18 fractional digits', function () {
    const v = '1000000.123456789012345678';
    expect(fmtAmount(v)).to.equal(v);
  });

  it('never emits scientific notation across random 18-decimal amounts', function () {
    for (let i = 0; i < 1000; i++) {
      const intLen = 1 + crypto.randomInt(25);
      const fracLen = 1 + crypto.randomInt(18);
      let intPart = '';
      for (let j = 0; j < intLen; j++) intPart += crypto.randomInt(10);
      let frac = '';
      for (let j = 0; j < fracLen; j++) frac += crypto.randomInt(10);
      const v = intPart + '.' + frac;
      const out = fmtAmount(v);
      expect(/e/i.test(out), `scientific notation for ${v} -> ${out}`).to.equal(false);
      // Value is preserved exactly (modulo leading-zero / trailing-zero
      // normalisation, which bignumber does deterministically). Cross-check by
      // re-parsing both sides as bignumbers.
      expect(u().bcnum(out).toString(), `value drift for ${v}`).to.equal(u().bcnum(v).toString());
    }
  });

  it('does NOT cast a non-numeric value in a numeric-named field (TYPE = MIME string)', function () {
    // TYPE is numeric (0/1) for LIST but a MIME string for FILE; casting
    // "text/plain" with bignumber would yield NaN and corrupt the action.
    const data = u().setNumberFormats({ TYPE: 'text/plain', AMOUNT: '5' });
    expect(data.TYPE).to.equal('text/plain');
    expect(data.AMOUNT).to.equal('5');
  });

  it('leaves null/undefined numeric fields untouched (no NaN coercion)', function () {
    const data = u().setNumberFormats({ AMOUNT: null });
    expect(data.AMOUNT).to.equal(null);
  });
});

// Regression: bcnum + bc* helpers preserve full precision (no JS double)
//
// bcnum used parseFloat/parseInt, and every bc* wrapper re-funnelled its
// already-correct fixed-notation result back through bcnum, throwing the
// precision away to a ~16-digit double (and re-emitting scientific notation for
// tiny values). The most damaging consumer is getPrice(...,64), whose result
// feeds ORDER GET_PRICE/GIVE_PRICE and drives order_match fills. bcnum now
// returns a full-precision bignumber (matching the indexer) and the wrappers
// return the fixed string directly.

describe('Regression: bc* helpers preserve full precision', function () {

  it('getPrice("1","3",64) yields a 64-digit price string, not a ~16-digit double', function () {
    const out = u().getPrice('1', '3', 64);
    expect(out).to.equal('0.' + '3'.repeat(64));
    expect(out).to.not.equal('0.3333333333333333');           // the old parseFloat double
    expect(/e/i.test(out), 'scientific notation leaked').to.equal(false);
  });

  it('bcadd preserves an 18-decimal fractional tail (1e-18 not lost)', function () {
    expect(u().bcadd('1000000000000.000000000000000001', '0', 18))
      .to.equal('1000000000000.000000000000000001');
  });

  it('bcsub/bcmul keep precision past 2^53', function () {
    // 2^53 + 1 would round to ...992 as a double.
    expect(u().bcsub('9007199254740993', '0', 0)).to.equal('9007199254740993');
    expect(u().bcmul('9007199254740993', '1', 0)).to.equal('9007199254740993');
  });

  it('bcdiv result re-parses to the exact value (no double drift)', function () {
    const q = u().bcdiv('2', '7', 50);
    // q is a 50-dp fixed string; re-parsing it as a bignumber must round-trip,
    // and it must carry far more than a double's ~16 significant digits.
    expect(/^0\.\d{50}$/.test(q), `unexpected shape: ${q}`).to.equal(true);
    expect(q.replace(/^0\./, '').replace(/0+$/, '').length).to.be.greaterThan(16);
    expect(/e/i.test(q)).to.equal(false);
  });

  it('bcnum returns a full-precision bignumber (round-trips beyond 2^53)', function () {
    expect(u().bcnum('9007199254740993').toString()).to.equal('9007199254740993');
    // non-numeric / NaN / Infinity guard → bignumber(0), never a throw
    expect(u().bcnum('text/plain').toString()).to.equal('0');
    expect(u().bcnum('Infinity').toString()).to.equal('0');
  });

  it('bcdiv guards against a zero denominator instead of returning Infinity/NaN', function () {
    const out = u().bcdiv('1', '0', 64);
    expect(out).to.equal('0.' + '0'.repeat(64));
    expect(/infinity/i.test(out)).to.equal(false);
    expect(/nan/i.test(out)).to.equal(false);
    expect(u().bcdiv('1', 0, 8)).to.equal('0.00000000');
    expect(u().getPrice('5', '0')).to.equal('0.' + '0'.repeat(64));
  });

  it('bcdiv/getPrice non-zero cases remain unaffected by the zero-denominator guard', function () {
    const q = u().bcdiv('2', '7', 50);
    expect(/^0\.\d{50}$/.test(q), `unexpected shape: ${q}`).to.equal(true);
    expect(u().getPrice('1', '3', 64)).to.equal('0.' + '3'.repeat(64));
  });
});
