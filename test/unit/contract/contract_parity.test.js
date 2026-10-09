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
// Contract-lint PARITY + DRIFT guard.
//
// The SDK's contract linter MUST match the indexer's deploy-time validator, or
// authors get false greens (lint passes, on-chain deploy rejects). Two guards:
//
//   1. DRIFT: the vendored src/contract/{lint-core,metering,stripped-globals}.js
//      AND every file under src/contract/{lint-core,metering}/ (same file set on
//      both sides) must be byte-identical (sha256) to the xchain-vm canonicals, AND the acorn,
//      acorn-walk and astring the SDK declares and installs must equal the
//      VM's consensus pin (AST_TOOLCHAIN_PINNED in consensus-runtime.js). (Skipped
//      when the sibling xchain-vm checkout is absent, e.g. SDK cloned standalone.)
//   2. VERDICT: a fixture corpus (good templates + one bad per rule) gets the
//      expected verdict from sdk.validateContract / contracts.validate.
//
// The cross-ENGINE check (validateContract vs vm.validateSyntax incl. the V8
// step) lives in xchain-vm's suite, where isolated-vm is available; because the
// vendored files, rule modules included, are proven byte-identical here AND run on the same pinned AST
// toolchain, that check transitively covers the SDK. Identical bytes on a
// different acorn/astring can still parse, walk or emit differently.

const assert = require('assert');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const XChainSDK    = require('../../../src/XChainSDK.js');
const ContractUtils = require('../../../src/contract/utils.js');
const { siblingCheckout, skipOrFail, siblingsRequired } = require('../../helpers/sibling_checkout.js');

const VENDORED_DIR = path.join(__dirname, '../..', '..', 'src', 'contract');
const SIBLING_ROOT = process.env.XCHAIN_SIBLING_ROOT || path.join(__dirname, '../..', '..', '..');
const VM_SRC_DIR   = path.join(process.env.XCHAIN_VM_DIR || path.join(SIBLING_ROOT, 'xchain-vm'), 'src');
const CONTRACTS_DIR = process.env.XCHAIN_CONTRACTS_DIR || path.join(SIBLING_ROOT, 'xchain-contracts');
// stripped_globals.js is in the vendor set because it is the ONE
// definition of the sandbox's stripped-global names, required by lint_core.js
// here and by sandbox.js / toolkit/authoring.js in xchain-vm. It is
// dependency-free so the single require line resolves at both vendored depths.
const VENDORED_FILES = ['lint-core.js', 'metering.js', 'stripped-globals.js'];
// The two top-level entries are thin requires over these directories, which hold the actual rules and gas placement.
const VENDORED_DIRS = ['lint-core', 'metering'];

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// List every regular file under base as sorted '/'-separated relative paths ([] when base is absent).
function listFiles(base, rel = '') {
    let entries;
    try { entries = fs.readdirSync(path.join(base, rel), { withFileTypes: true }); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    let out = [];
    for (const entry of entries) {
        const child = rel ? rel + '/' + entry.name : entry.name;
        if (entry.isDirectory()) out = out.concat(listFiles(base, child));
        else if (entry.isFile()) out.push(child);
    }
    return out.sort();
}

// Map the VM pin's keys to the npm names the SDK declares and installs.
const AST_TOOLCHAIN_PACKAGES = { acorn: 'acorn', acornWalk: 'acorn-walk', astring: 'astring' };
const SDK_PACKAGE_JSON = path.join(__dirname, '../..', '..', 'package.json');

// Read an installed package's version by walking up from its main entry
// (astring's `exports` field blocks requiring astring/package.json directly).
function installedVersion(name) {
    let dir = path.dirname(require.resolve(name));
    for (;;) {
        const pj = path.join(dir, 'package.json');
        if (fs.existsSync(pj)) {
            const j = JSON.parse(fs.readFileSync(pj, 'utf8'));
            if (j.name === name) return j.version;
        }
        const up = path.dirname(dir);
        if (up === dir) return null;
        dir = up;
    }
}

// A parity guard must never silently pass by skipping, nor pass against a
// sibling no commit pins. The shared helper refuses an absent sibling and a
// lane-worktree symlink into a live main checkout; a refusal fails when
// XCHAIN_REQUIRE_SIBLINGS=1 and skips otherwise. Returns false (caller should
// `return`) when it skipped; throws when the sibling was declared supplied.
const SIBLING_REQUIRED = siblingsRequired();
function requireSibling(ctx, absPath) {
    return skipOrFail(ctx, siblingCheckout(__dirname, absPath), 'the contract-lint parity guard against ' + absPath);
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

// Register the drift checks for one vendored directory: non-empty, same file set, and each file byte-identical.
function dirDriftCases(dir) {
    const own = listFiles(path.join(VENDORED_DIR, dir));
    // Fail closed on a vacuous pass: a renamed or emptied directory must go red, never generate zero checks
    it('src/contract/' + dir + '/ is present and non-empty, so its drift checks cannot pass vacuously', function () {
        assert.ok(own.length > 0, 'NO VENDORED FILES: src/contract/' + dir +
            '/ is missing or empty, so the per-file drift guard below would check nothing.');
    });
    // Refuse a file added, removed or renamed on one side only, which a per-file hash of one side cannot see
    it('src/contract/' + dir + '/ file set matches xchain-vm/src/' + dir + '/', function () {
        if (!requireSibling(this, VM_SRC_DIR)) return;
        const canonical = listFiles(path.join(VM_SRC_DIR, dir));
        assert.ok(canonical.length > 0, 'NO CANONICAL: xchain-vm has no files under ' +
            path.join(VM_SRC_DIR, dir) + '; the sibling checkout is stale, or the directory moved.');
        const missingHere = canonical.filter((f) => !own.includes(f));
        const onlyHere = own.filter((f) => !canonical.includes(f));
        assert.ok(missingHere.length === 0 && onlyHere.length === 0,
            'VENDOR DRIFT: ' + dir + '/ file sets differ. Missing from the SDK copy: [' + missingHere.join(', ') +
            ']. Present only in the SDK copy: [' + onlyHere.join(', ') + '].');
    });
    for (const rel of own) {
        const f = dir + '/' + rel;
        it('src/contract/' + f + ' matches xchain-vm/src/' + f, function () {
            if (!requireSibling(this, VM_SRC_DIR)) return;
            const canonical = path.join(VM_SRC_DIR, f);
            assert.ok(fs.existsSync(canonical), 'NO CANONICAL: ' + f + ' is vendored here but xchain-vm has no ' +
                canonical + '; the sibling checkout is stale, or the file was renamed/removed upstream.');
            assert.strictEqual(sha256(path.join(VENDORED_DIR, f)), sha256(canonical),
                'VENDOR DRIFT: ' + f + ' differs from xchain-vm canonical; re-sync the copy.');
        });
    }
}

describe('contract-lint parity + drift', function () {

    describe('drift guard (vendored copies byte-identical to xchain-vm)', function () {
        for (const f of VENDORED_FILES) {
            it('src/contract/' + f + ' matches xchain-vm/src/' + f, function () {
                if (!requireSibling(this, VM_SRC_DIR)) return;
                const vendored = path.join(VENDORED_DIR, f);
                const canonical = path.join(VM_SRC_DIR, f);
                // requireSibling proves the DIRECTORY resolves, never the per-file
                // canonical, so a stale sibling checkout (or a vendored file enrolled
                // before its canonical lands) reaches sha256 with no file. Fail closed
                // and name it, the contract check-preflight-drift.js holds for a
                // mapped-but-missing handler, rather than raising a raw ENOENT that
                // reads as a broken harness instead of as the finding.
                assert.ok(
                    fs.existsSync(canonical),
                    'NO CANONICAL: ' + f + ' is in VENDORED_FILES but xchain-vm has no ' + canonical +
                    '; the sibling checkout is stale, or the file was renamed/removed upstream.'
                );
                assert.strictEqual(
                    sha256(vendored), sha256(canonical),
                    'VENDOR DRIFT: ' + f + ' differs from xchain-vm canonical; re-sync the copy.'
                );
            });
        }

        for (const dir of VENDORED_DIRS) dirDriftCases(dir);

        // Gas placement is a function of the AST toolchain, so byte-identical copies need the same versions.
        it('declared and installed acorn/acorn-walk/astring equal xchain-vm AST_TOOLCHAIN_PINNED', function () {
            if (!requireSibling(this, VM_SRC_DIR)) return;
            const runtime = path.join(VM_SRC_DIR, 'consensus-runtime.js');
            assert.ok(fs.existsSync(runtime),
                'NO CANONICAL: xchain-vm has no ' + runtime + '; the sibling checkout is stale, or the pin moved.');
            const { AST_TOOLCHAIN_PINNED } = require(runtime);
            assert.ok(AST_TOOLCHAIN_PINNED, 'xchain-vm consensus-runtime.js no longer exports AST_TOOLCHAIN_PINNED');
            assert.deepStrictEqual(Object.keys(AST_TOOLCHAIN_PINNED).sort(), Object.keys(AST_TOOLCHAIN_PACKAGES).sort(),
                'xchain-vm AST_TOOLCHAIN_PINNED names a different library set; update AST_TOOLCHAIN_PACKAGES to match');
            const declared = JSON.parse(fs.readFileSync(SDK_PACKAGE_JSON, 'utf8')).dependencies;
            for (const [key, pkg] of Object.entries(AST_TOOLCHAIN_PACKAGES)) {
                const pin = AST_TOOLCHAIN_PINNED[key];
                assert.strictEqual(declared[pkg], pin, 'AST TOOLCHAIN DRIFT: package.json declares ' + pkg + ' '
                    + declared[pkg] + ' but the xchain-vm consensus pin is exactly ' + pin);
                assert.strictEqual(installedVersion(pkg), pin, 'AST TOOLCHAIN DRIFT: installed ' + pkg + ' '
                    + installedVersion(pkg) + ' != xchain-vm consensus pin ' + pin + '; bump both with a CONSENSUS_VERSION change');
            }
        });
    });

});

describe('contract-lint parity + drift', function () {

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

});

describe('contract-lint parity + drift', function () {

    describe('Move 2: logic-level rules (advisory, never deploy-blocking)', function () {
        const { CONSENSUS_RULES } = require('../../../src/contract/lint-core.js');
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
            const dir = CONTRACTS_DIR;
            if (!requireSibling(this, dir)) return;
            for (const name of ['escrow', 'vesting', 'crowdsale', 'amm']) {
                const f = path.join(dir, name, name + '.js');
                // Fail closed on a missing template, the same way NO CANONICAL does above
                assert.ok(fs.existsSync(f), 'NO TEMPLATE: ' + name + ' is listed here but xchain-contracts has no ' + f +
                    '; the sibling checkout is stale, or the template was renamed/removed (update this list).');
                const r = sdk.validateContract(fs.readFileSync(f, 'utf8'));
                assert.strictEqual(r.errors.length, 0, name + ' errors: ' + JSON.stringify(r.errors));
                assert.strictEqual(r.warnings.length, 0, name + ' warnings: ' + JSON.stringify(r.warnings.map(w => w.rule)));
            }
        });
    });

});

describe('contract-lint parity + drift', function () {

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

});

describe('contract-lint parity + drift', function () {

    describe('the four shipped templates lint clean (acorn-coverable rules)', function () {
        const templatesCheckout = siblingCheckout(__dirname, CONTRACTS_DIR);
        const haveTemplates = templatesCheckout.usable;
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
                if (!haveTemplates && !skipOrFail(this, templatesCheckout, 'the template-parity guard')) return;
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
