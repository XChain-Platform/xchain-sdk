// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// ─────────────────────────────────────────────────────────────────────────────
// Contract-lint PARITY + DRIFT guard.
//
// The SDK's contract linter MUST match the indexer's deploy-time validator, or
// authors get false greens (lint passes, on-chain deploy rejects). Two guards:
//
//   1. DRIFT: the vendored src/contract/{lint-core,metering}.js must be
//      byte-identical (sha256) to the xchain-vm canonicals. (Skipped when the
//      sibling xchain-vm checkout is absent, e.g. SDK cloned standalone.)
//   2. VERDICT: a fixture corpus (good templates + one bad per rule) gets the
//      expected verdict from sdk.validateContract / contracts.validate.
//
// The cross-ENGINE check (validateContract vs vm.validateSyntax incl. the V8
// step) lives in xchain-vm's suite, where isolated-vm is available; because the
// vendored files are proven byte-identical here, that check transitively covers
// the SDK.
// ─────────────────────────────────────────────────────────────────────────────

const assert = require('assert');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const XChainSDK    = require('../../src/XChainSDK.js');
const ContractUtils = require('../../src/contracts.js');

const VENDORED_DIR = path.join(__dirname, '..', '..', 'src', 'contract');
const VM_SRC_DIR   = path.join(__dirname, '..', '..', '..', 'xchain-vm', 'src');
const CONTRACTS_DIR = path.join(__dirname, '..', '..', '..', 'xchain-contracts');
const VENDORED_FILES = ['lint-core.js', 'metering.js'];

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// A parity guard must never silently pass by skipping. When the sibling is
// present we run; when it is absent we HARD-FAIL only where the sibling is
// REQUIRED, i.e. the job that checks it out and sets XCHAIN_REQUIRE_SIBLINGS=1,
// so the guard can never green-by-skip there (mirrors xchain-sync's
// rollback-coverage requireSibling). We do NOT key on the generic CI flag:
// the shared unit job sets CI=true without checking out siblings. Returns
// false (caller should `return`) when it skipped; throws when required-but-missing.
const SIBLING_REQUIRED = process.env.XCHAIN_REQUIRE_SIBLINGS === '1';
function requireSibling(ctx, absPath) {
    if (fs.existsSync(absPath)) return true;
    if (SIBLING_REQUIRED)
        throw new Error('parity guard cannot run: required sibling missing at ' + absPath +
            ' (the job setting XCHAIN_REQUIRE_SIBLINGS=1 must check out the sibling repo)');
    ctx.skip();
    return false;
}

// One bad fixture per acorn-coverable rule + a float-warning fixture.
const BAD_FIXTURES = [
    { name: 'banned-math',          rule: 'banned-math',         code: 'function f(){ return Math.sqrt(4); }' },
    { name: 'banned-literal-bigint', rule: 'banned-literal',     code: 'function f(){ return 2n; }' },
    { name: 'banned-literal-regex', rule: 'banned-literal',      code: 'function f(){ return /a+/.test("x"); }' },
    { name: 'reserved-gas',         rule: 'reserved-identifier', code: 'function f(){ var __gas = 1; return __gas; }' },
    { name: 'reserved-alloc',       rule: 'reserved-identifier', code: 'function f(){ return __concat([1],[2]); }' },
    { name: 'unsupported-syntax',   rule: 'unsupported-syntax',  code: 'var x = 1_000; function f(){ return x; }' }
];
const FLOAT_FIXTURE = { code: 'var x = 3.14; function f(){ return x; }' };
const GOOD_FIXTURE  = 'function init(){ return 1; } function add(a,b){ return a + b; }';

describe('contract-lint parity + drift', function () {

    describe('drift guard (vendored copies byte-identical to xchain-vm)', function () {
        for (const f of VENDORED_FILES) {
            it('src/contract/' + f + ' matches xchain-vm/src/' + f, function () {
                if (!requireSibling(this, VM_SRC_DIR)) return;
                const vendored = path.join(VENDORED_DIR, f);
                const canonical = path.join(VM_SRC_DIR, f);
                assert.strictEqual(
                    sha256(vendored), sha256(canonical),
                    'VENDOR DRIFT: ' + f + ' differs from xchain-vm canonical; re-sync the copy.'
                );
            });
        }
    });

    describe('verdict corpus: sdk.validateContract', function () {
        let sdk;
        before(function () { sdk = new XChainSDK({ network: 'bitcoin-regtest', noHub: true }); });

        it('good contract → valid, no errors, advisory (authoritative:false)', function () {
            const r = sdk.validateContract(GOOD_FIXTURE);
            assert.strictEqual(r.valid, true);
            assert.strictEqual(r.errors.length, 0);
            assert.strictEqual(r.authoritative, false);
        });

        for (const fx of BAD_FIXTURES) {
            it('bad fixture "' + fx.name + '" → invalid with rule ' + fx.rule, function () {
                const r = sdk.validateContract(fx.code);
                assert.strictEqual(r.valid, false, fx.name + ' should be invalid');
                assert.ok(
                    r.errors.some(e => e.rule === fx.rule),
                    fx.name + ' expected rule ' + fx.rule + ', got ' + JSON.stringify(r.errors.map(e => e.rule))
                );
            });
        }

        it('float literal → valid with a float-literal warning', function () {
            const r = sdk.validateContract(FLOAT_FIXTURE.code);
            assert.strictEqual(r.valid, true);
            assert.ok(r.warnings.some(w => w.rule === 'float-literal'));
        });

        it('never reports valid:true for an acorn-coverable bad fixture (no false greens)', function () {
            for (const fx of BAD_FIXTURES)
                assert.strictEqual(sdk.validateContract(fx.code).valid, false, 'false green on ' + fx.name);
        });
    });

    describe('Move 2: logic-level rules (advisory, never deploy-blocking)', function () {
        const { CONSENSUS_RULES } = require('../../src/contract/lint-core.js');
        let sdk;
        before(function () { sdk = new XChainSDK({ network: 'bitcoin-regtest', noHub: true }); });

        it('crossCallable non-array → error (rule crossCallable-not-array), but NOT a consensus rule', function () {
            const r = sdk.validateContract('module.exports = { foo: function(){}, crossCallable: "oops" };');
            assert.strictEqual(r.valid, false);
            const e = r.errors.find(x => x.rule === 'crossCallable-not-array');
            assert.ok(e, 'expected crossCallable-not-array error');
            assert.strictEqual(e.severity, 'error');
            // The chain still accepts it; it must NOT be in the deploy-blocking set.
            assert.ok(!CONSENSUS_RULES.has('crossCallable-not-array'),
                'crossCallable-not-array must never be a consensus (deploy-blocking) rule');
        });

        it('crossCallable array with an unknown method → warning, stays valid', function () {
            const r = sdk.validateContract('module.exports = { foo: function(){}, crossCallable: ["foo","bar"] };');
            assert.strictEqual(r.valid, true);
            assert.ok(r.warnings.some(w => w.rule === 'crossCallable-unknown-method'));
        });

        const WARN_FIXTURES = [
            { rule: 'unbounded-loop',           code: 'function f(){ while(true){ break; } }' },
            { rule: 'large-allocation',         code: 'function f(){ return new Array(1000).fill(0); }' },
            { rule: 'unchecked-state-get',      code: 'function f(){ return xchain.state.get("k").foo; }' },
            { rule: 'missing-input-validation', code: 'module.exports = { foo: function(xchain){ return xchain.getInputParam(0); } };' }
        ];
        for (const fx of WARN_FIXTURES) {
            it(fx.rule + ' → warning only (valid stays true)', function () {
                const r = sdk.validateContract(fx.code);
                assert.strictEqual(r.valid, true, fx.rule + ' must not block (it is advisory)');
                assert.ok(r.warnings.some(w => w.rule === fx.rule),
                    'expected warning ' + fx.rule + ', got ' + JSON.stringify(r.warnings.map(w => w.rule)));
            });
        }

        it('the four templates emit zero Move-2 findings (low false-positive)', function () {
            const fs = require('fs');
            const dir = path.join(__dirname, '..', '..', '..', 'xchain-contracts');
            if (!requireSibling(this, dir)) return;
            for (const name of ['escrow', 'vesting', 'crowdsale', 'amm']) {
                const f = path.join(dir, name, name + '.js');
                if (!fs.existsSync(f)) continue;
                const r = sdk.validateContract(fs.readFileSync(f, 'utf8'));
                assert.strictEqual(r.errors.length, 0, name + ' errors: ' + JSON.stringify(r.errors));
                assert.strictEqual(r.warnings.length, 0, name + ' warnings: ' + JSON.stringify(r.warnings.map(w => w.rule)));
            }
        });
    });

    describe('back-compat: ContractUtils.validate() shape', function () {
        const utils = new ContractUtils();
        it('good → { valid:true }', function () {
            assert.strictEqual(utils.validate(GOOD_FIXTURE).valid, true);
        });
        it('bad → { valid:false, error:<string> }', function () {
            const r = utils.validate('function f(){ return Math.pow(2,3); }');
            assert.strictEqual(r.valid, false);
            assert.strictEqual(typeof r.error, 'string');
            assert.ok(r.error.includes('Math.pow'));
        });
    });

    describe('the four shipped templates lint clean (acorn-coverable rules)', function () {
        const haveTemplates = fs.existsSync(CONTRACTS_DIR);
        let sdk;
        before(function () { sdk = new XChainSDK({ network: 'bitcoin-regtest', noHub: true }); });

        const dirs = haveTemplates
            ? fs.readdirSync(CONTRACTS_DIR, { withFileTypes: true })
                .filter(d => d.isDirectory() && fs.existsSync(path.join(CONTRACTS_DIR, d.name, d.name + '.js')))
                .map(d => d.name)
            : [];

        if (!haveTemplates || dirs.length === 0) {
            it('xchain-contracts templates present', function () {
                // Green-by-skip is only acceptable in a per-repo unit run; the
                // job that checks out siblings must hard-fail on absence.
                if (SIBLING_REQUIRED)
                    throw new Error('template-parity guard cannot run: xchain-contracts templates missing at ' +
                        CONTRACTS_DIR + ' with XCHAIN_REQUIRE_SIBLINGS=1');
                this.skip();
            });
        } else {
            for (const name of dirs) {
                it(name + ' has no acorn-coverable lint errors', function () {
                    const code = fs.readFileSync(path.join(CONTRACTS_DIR, name, name + '.js'), 'utf8');
                    const r = sdk.validateContract(code);
                    assert.strictEqual(r.valid, true,
                        name + ' lint errors: ' + JSON.stringify(r.errors.map(e => e.message)));
                });
            }
        }
    });

});
