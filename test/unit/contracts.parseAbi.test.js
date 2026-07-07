// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// ContractUtils.parseAbi (spec: xchain-documentation/protocol/Contract_ABI.md).
// The fixture strings are duplicated verbatim from the explorer suite
// (xchain-explorer/test/unit/contract-introspect.test.js) so the two
// hand-synced parser copies are tested against identical inputs.

const assert = require('assert');
const ContractUtils = require('../../src/contracts.js');

describe('ContractUtils.parseAbi()', function () {

    let utils;
    beforeEach(function () { utils = new ContractUtils(); });

    it('parses a well-formed abi block with typed params, summary, and view', function () {
        const abi = utils.parseAbi(`module.exports = {
            abi: { version: 1, methods: {
                fund:   { summary: 'Deposit the escrow amount', params: [ { name: 'tick', type: 'tick' }, { name: 'amount', type: 'amount' } ] },
                status: { summary: 'Read escrow status', params: [], view: true }
            } },
            fund: function(xchain){}, status: function(xchain){}
        };`);
        assert.strictEqual(abi.version, 1);
        assert.deepStrictEqual(abi.methods.fund.params, [
            { name: 'tick', type: 'tick' }, { name: 'amount', type: 'amount' }
        ]);
        assert.strictEqual(abi.methods.fund.summary, 'Deposit the escrow amount');
        assert.strictEqual(abi.methods.status.view, true);
    });

    it('drops only the malformed method entry, keeping the rest', function () {
        const abi = utils.parseAbi(`module.exports = {
            abi: { version: 1, methods: {
                good:   { params: [ { name: 'x', type: 'string' } ] },
                badType: { params: [ { name: 'x', type: 'floatish' } ] },
                badShape: { params: 'nope' }
            } },
            good: function(xchain){}, badType: function(xchain){}, badShape: function(xchain){}
        };`);
        assert.deepStrictEqual(Object.keys(abi.methods), ['good']);
    });

    it('returns null when version is not a numeric literal', function () {
        assert.strictEqual(utils.parseAbi(`module.exports = { abi: { version: '1', methods: {} }, run: function(x){} };`), null);
    });

    it('returns null for a dynamic (non-literal) abi value', function () {
        assert.strictEqual(utils.parseAbi(`const a = { version: 1, methods: {} }; module.exports = { abi: a, run: function(x){} };`), null);
    });

    it('treats an abi-named FUNCTION as an ordinary method, not metadata', function () {
        assert.strictEqual(utils.parseAbi(`module.exports = { abi: function(xchain){ return 1; } };`), null);
    });

    it('returns null for function-export contracts', function () {
        assert.strictEqual(utils.parseAbi(`module.exports = function(xchain){ return 1; };`), null);
    });

    it('defaults omitted params to an empty array and omitted view to absent', function () {
        const abi = utils.parseAbi(`module.exports = {
            abi: { version: 1, methods: { ping: { summary: 'Ping' } } },
            ping: function(xchain){}
        };`);
        assert.deepStrictEqual(abi.methods.ping.params, []);
        assert.strictEqual('view' in abi.methods.ping, false);
    });

    it('returns null on unparseable source and non-string input', function () {
        assert.strictEqual(utils.parseAbi('syntax error ('), null);
        assert.strictEqual(utils.parseAbi(null), null);
        assert.strictEqual(utils.parseAbi(12345), null);
    });
});
