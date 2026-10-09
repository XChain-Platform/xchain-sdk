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
 * Stripped-global vendor and BigInt native-surface parity.
 ********************************************************************/
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout.js');

const SDK_ROOT = path.join(__dirname, '..', '..', '..');
const SDK_COPY = path.join(SDK_ROOT, 'src', 'contract', 'stripped-globals.js');
const SIBLING_ROOT = process.env.XCHAIN_SIBLING_ROOT || path.join(SDK_ROOT, '..');
const VM_DIR = path.resolve(process.env.XCHAIN_VM_DIR || path.join(SIBLING_ROOT, 'xchain-vm'));
const VM_SOURCE = path.join(VM_DIR, 'src', 'stripped-globals.js');
const VM_SANDBOX = path.join(VM_DIR, 'src', 'sandbox.js');
const VM_DIGEST_TEST = path.join(
    VM_DIR,
    'test',
    'determinism',
    'consensus_params.test',
    '03_bigint_surface_strip_digest.test.js'
);

function requireVmSibling(ctx) {
    return skipOrFail(
        ctx,
        siblingCheckout(__dirname, VM_DIR),
        'the stripped-globals and BigInt surface parity guard against ' + VM_DIR
    );
}

function frozenStringArray(source, name) {
    const match = source.match(new RegExp(
        'const\\s+' + name + '\\s*=\\s*Object\\.freeze\\((\\[[\\s\\S]*?\\])\\);'
    ));
    assert.ok(match, name + ' must remain an Object.freeze array literal');
    return JSON.parse(match[1].replace(/'/g, '"'));
}

describe('stripped-globals BigInt surface parity', function () {
    it('exports the frozen BigInt typed-array strip surface', function () {
        delete require.cache[require.resolve(SDK_COPY)];
        const sdkGlobals = require(SDK_COPY);
        assert.ok(Object.isFrozen(sdkGlobals.BIGINT_SURFACE_STRIPPED_GLOBAL_NAMES));
        assert.deepStrictEqual(
            sdkGlobals.BIGINT_SURFACE_STRIPPED_GLOBAL_NAMES,
            ['BigInt64Array', 'BigUint64Array']
        );
    });

    it('keeps the SDK stripped-globals vendor byte-identical to xchain-vm', function () {
        if (!requireVmSibling(this)) return;
        assert.strictEqual(
            Buffer.compare(fs.readFileSync(SDK_COPY), fs.readFileSync(VM_SOURCE)),
            0,
            'src/contract/stripped-globals.js differs byte for byte from xchain-vm/src/stripped-globals.js'
        );
    });

    it('pins the VM BigInt typed-array globals beside the split consensus digest guard', function () {
        if (!requireVmSibling(this)) return;
        const names = frozenStringArray(
            fs.readFileSync(VM_SANDBOX, 'utf8'),
            'BIGINT_SURFACE_STRIPPED_GLOBAL_NAMES'
        );
        assert.deepStrictEqual(names, ['BigInt64Array', 'BigUint64Array']);
        assert.ok(
            fs.existsSync(VM_DIGEST_TEST),
            'BigInt surface digest guard is missing at ' + VM_DIGEST_TEST
        );
        const digestGuard = fs.readFileSync(VM_DIGEST_TEST, 'utf8');
        assert.ok(
            digestGuard.includes('sandbox.BIGINT_SURFACE_STRIPPED_GLOBAL_NAMES'),
            'BigInt surface digest guard no longer pins the sandbox global list'
        );
    });
});
