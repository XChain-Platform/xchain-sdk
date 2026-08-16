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
 **********************************************************************
 * test/unit/contract-lint-global-alias.test.js
 *
 * LINT_GLOBAL_ALIAS behaviour through the SDK's VENDORED lint-core.
 *
 * contract-parity.test.js already pins the vendored copy byte-identical (sha256)
 * to the xchain-vm canonical, but only when the sibling checkout is present. This
 * suite pins the BEHAVIOUR the SDK's pre-flight linter must show whether or not a
 * sibling is around: an author writing `this.WebAssembly` or
 * `globalThis.globalThis.Promise` gets the same error-severity consensus finding
 * the deploy validator will produce once the epoch is armed, and the epoch flag
 * still resolves the pre-activation verdict when it is switched off.
 *
 * The SDK linter is author-facing, so its default is ON (warn me now about what
 * will be rejected), while the chain applies the rule only at/after the per-coin
 * activation height (xchain-vm LINT_GLOBAL_ALIAS_ACTIVATION /
 * xchain-indexer vm_lint_global_alias_activation.js), which is still unarmed on
 * mainnet.
 ********************************************************************/
'use strict';

const assert = require('assert');
const {
    lintSource,
    findBannedAsync,
    findBannedWasm,
    CONSENSUS_RULES
} = require('../../src/contract/lint-core.js');

function firstConsensusError(code, opts) {
    const errs = lintSource(code, opts).errors.filter((e) => CONSENSUS_RULES.has(e.rule));
    return errs.length ? errs[0] : null;
}

describe('vendored lint-core: LINT_GLOBAL_ALIAS rules', function () {

    const aliased = {
        'sloppy-mode this reading Promise':       ['banned-async', 'module.exports = function(){ return this.Promise; };'],
        'sloppy-mode this reading WebAssembly':   ['banned-wasm',  'module.exports = function(){ return this.WebAssembly; };'],
        'globalThis self-reference to Promise':   ['banned-async', 'module.exports = function(){ return globalThis.globalThis.Promise; };'],
        'globalThis self-reference to wasm':      ['banned-wasm',  'module.exports = function(){ return globalThis["globalThis"].WebAssembly; };'],
        'this-rooted globalThis chain':           ['banned-async', 'module.exports = function(){ return this.globalThis.Promise; };']
    };

    for (const [label, [rule, code]] of Object.entries(aliased)) {
        it('flags ' + label + ' by default (author-facing linter)', function () {
            const err = firstConsensusError(code);
            assert.ok(err, 'expected a consensus error for: ' + code);
            assert.strictEqual(err.rule, rule);
        });

        it('accepts ' + label + ' with the epoch off (pre-activation verdict)', function () {
            assert.strictEqual(firstConsensusError(code, { globalAlias: false }), null,
                'below the activation the historical verdict must be reproduced: ' + code);
        });
    }

    it('the detectors take the epoch flag directly', function () {
        const promise = 'module.exports = function(){ return this.Promise; };';
        const wasm    = 'module.exports = function(){ return this.WebAssembly; };';
        assert.strictEqual(findBannedAsync(promise, true, true).length, 1);
        assert.deepStrictEqual(findBannedAsync(promise, true, false), []);
        assert.strictEqual(findBannedWasm(wasm, true).length, 1);
        assert.deepStrictEqual(findBannedWasm(wasm, false), []);
    });

    it('leaves the pre-epoch spellings blocking in both modes', function () {
        // The gate widens the rule; it must never make the already-live half optional.
        for (const code of [
            'module.exports = function(){ return Promise; };',
            'module.exports = function(){ return globalThis.WebAssembly; };'
        ]) {
            assert.ok(firstConsensusError(code, { globalAlias: false }), 'epoch off: ' + code);
            assert.ok(firstConsensusError(code, { globalAlias: true }),  'epoch on: '  + code);
        }
    });

    it('does not red-line ordinary contract code', function () {
        for (const code of [
            'module.exports = function(){ return this.total; };',
            'module.exports = function(o){ return o.Promise; };',
            'module.exports = function(Promise){ return Promise; };'
        ]) {
            assert.strictEqual(firstConsensusError(code), null, 'false positive on: ' + code);
        }
    });
});
