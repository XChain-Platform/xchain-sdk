// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout.js');

// The bitcoinjs-lib 6 shim only runs when version 6 is what resolves, and this
// package pins 7, so the check runs in a child process whose bitcoinjs-lib and
// bip174 come from a sibling checkout that still carries version 6.
const SIBLING_ROOT = process.env.XCHAIN_SIBLING_ROOT || path.resolve(__dirname, '../../../..');
const DECODER = path.resolve(process.env.XCHAIN_DECODER_DIR || path.join(SIBLING_ROOT, 'xchain-decoder'));
const V6_SHIM = path.resolve(__dirname, '../../../src/utils/apply_bufferutils_patch/v6.js');

const CHILD = `
const Module = require('module');
const resolve = Module._resolveFilename;
const modules = process.env.V6_MODULES;
Module._resolveFilename = function (request, parent, ...rest) {
    if (/^(bitcoinjs-lib|bip174)(\\/|$)/.test(request)) request = modules + '/' + request;
    return resolve.call(this, request, parent, ...rest);
};
const { Psbt } = require('bitcoinjs-lib');
require(process.env.V6_SHIM);
function finalized(inputValue, outputValue) {
    const psbt = new Psbt();
    psbt.addInput({ hash: Buffer.alloc(32, 1), index: 0,
        witnessUtxo: { script: Buffer.from('0014' + '11'.repeat(20), 'hex'), value: inputValue } });
    psbt.addOutput({ script: Buffer.from('0014' + '22'.repeat(20), 'hex'), value: outputValue });
    psbt.updateInput(0, { finalScriptWitness: Buffer.from([0]) });
    return psbt;
}
const small = finalized(9007199254740993n, 9007199254740000n);
const big = finalized(20000000000000001n, 9007199254740993n);
let extractError = null;
try { big.extractTransaction(); } catch (e) { extractError = e.message; }
const bigFee = big.getFee();
console.log(JSON.stringify({
    smallFeeType: typeof small.getFee(), smallFee: String(small.getFee()),
    bigFeeType: typeof bigFee, bigFee: String(bigFee),
    bigRateType: typeof big.getFeeRate(), extractError,
}));
`;

describe('bitcoinjs-lib 6 fee shim keeps the Number-or-BigInt reader rule', function () {
    let result;

    before(function () {
        const verdict = siblingCheckout(__dirname, DECODER);
        if (!skipOrFail(this, verdict, 'the bitcoinjs-lib 6 fee shim check against xchain-decoder node_modules')) return;
        const modules = path.join(verdict.path, 'node_modules');
        const manifest = path.join(modules, 'bitcoinjs-lib', 'package.json');
        const v6 = fs.existsSync(manifest) && /^6\./.test(JSON.parse(fs.readFileSync(manifest, 'utf8')).version);
        if (!skipOrFail(this, { usable: v6, reason: 'no bitcoinjs-lib 6 install at ' + modules }, 'the bitcoinjs-lib 6 fee shim check')) return;
        const out = cp.execFileSync(process.execPath, ['-e', CHILD], {
            encoding: 'utf8', env: Object.assign({}, process.env, { V6_MODULES: modules, V6_SHIM }),
        });
        result = JSON.parse(out.trim().split('\n').pop());
    });

    it('returns a Number for a fee that is exactly representable', function () {
        expect(result.smallFeeType).to.equal('number');
        expect(result.smallFee).to.equal('993');
    });

    it('returns the exact BigInt for a fee above 2^53-1', function () {
        expect(result.bigFeeType).to.equal('bigint');
        expect(result.bigFee).to.equal((20000000000000001n - 9007199254740993n).toString());
    });

    it('keeps the fee rate a Number so the stock fee check can multiply it', function () {
        expect(result.bigRateType).to.equal('number');
        expect(result.extractError).to.match(/paying around/);
    });
});
