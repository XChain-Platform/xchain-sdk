'use strict';

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
 * Two pins on gen-action-roundtrip-golden.js, both found broken 2026-09-10
 * while measuring the v0.17.0 README:
 *
 * 1. LOADING the generator must not write anything. `npm run test:all` is
 *    `mocha --recursive test/`, which loads every .js under test/, this
 *    directory included. The generator's write used to sit at module top
 *    level, so running test:all (or readme-stats.js, which runs it) silently
 *    rewrote action-roundtrip-golden.json, a consensus-visible byte-layout
 *    golden, in whatever checkout it ran in. Asserted in a CHILD process with
 *    a sentinel in place of the golden: in-process the module is already
 *    cached by the time this file runs, so a re-require would prove nothing.
 *
 * 2. The committed golden must be exactly what its own generator produces.
 *    It was not: UNSTAKE v0's `parsed` key order had drifted from the
 *    indexer's live format template, so following the file's own regenerate
 *    instruction produced a diff the header calls a consensus-visible wire
 *    change. This test fails the moment the two part ways again.
 *
 * This file lives beside the generator so it runs in the same test:all glob
 * that used to do the damage.
 ********************************************************************/

const assert  = require('assert');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const { execFileSync } = require('child_process');

const gen = require('./gen-action-roundtrip-golden.js');

const GOLDEN_PATH = path.join(__dirname, 'action-roundtrip-golden.json');
const GEN_PATH    = path.join(__dirname, 'gen-action-roundtrip-golden.js');

// The generator needs the sibling xchain-indexer checkout to drive the parser
// half. Absent it (single-repo clone), the reproducibility half cannot run;
// the no-side-effect half still can and must.
function siblingIndexerPresent() {
    return fs.existsSync(path.join(gen.IDX_ROOT, 'src', 'utility.js')) &&
           fs.existsSync(path.join(gen.IDX_ROOT, 'src', 'actions'));
}

describe('action-roundtrip golden generator', function () {

    it('requiring the generator writes nothing to the golden', function () {
        this.timeout(60000);
        const original = fs.readFileSync(GOLDEN_PATH);
        const backup   = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xc-golden-')), 'golden.json');
        fs.writeFileSync(backup, original);

        // A sentinel the generator could never emit, so any write at all shows up.
        const SENTINEL = '{"sentinel":"if this is gone, requiring the generator wrote the golden"}\n';
        try {
            fs.writeFileSync(GOLDEN_PATH, SENTINEL);
            execFileSync(process.execPath, ['-e', `require(${JSON.stringify(GEN_PATH)});`], { stdio: 'pipe' });
            assert.strictEqual(
                fs.readFileSync(GOLDEN_PATH, 'utf8'), SENTINEL,
                'requiring gen-action-roundtrip-golden.js rewrote the consensus-visible golden; ' +
                'the write must stay behind the require.main === module guard');
        } finally {
            fs.writeFileSync(GOLDEN_PATH, fs.readFileSync(backup));
        }
    });

    it('the committed golden is exactly what the generator produces', function () {
        this.timeout(60000);
        if (!siblingIndexerPresent()) this.skip(); // single-repo clone: no parser half
        const committed  = fs.readFileSync(GOLDEN_PATH, 'utf8');
        const regenerated = gen.serializeGoldenDoc(gen.buildGoldenDoc());
        assert.strictEqual(regenerated, committed,
            'the committed action-roundtrip-golden.json is not reproducible from its own generator; ' +
            'following the file\'s regenerate instruction would produce a diff its header calls a ' +
            'consensus-visible wire change');
    });

    it('running the generator as a script leaves the committed golden byte-identical', function () {
        this.timeout(60000);
        if (!siblingIndexerPresent()) this.skip();
        const before = fs.readFileSync(GOLDEN_PATH);
        const backup = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xc-golden-')), 'golden.json');
        fs.writeFileSync(backup, before);
        try {
            execFileSync(process.execPath, [GEN_PATH], { stdio: 'pipe' });
            assert.ok(fs.readFileSync(GOLDEN_PATH).equals(before),
                'a regenerate run changed the committed golden bytes');
        } finally {
            fs.writeFileSync(GOLDEN_PATH, fs.readFileSync(backup));
        }
    });
});
