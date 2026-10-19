/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * The SPV merkle byte layer, bound from THIS side of the seam.
 *
 * src/merkle.js and src/merkle/primitives.js are carried byte-identically
 * with xchain-indexer/src/consensus/merkle.js and merkle/primitives.js (the
 * canonical copies), and with the xchain-sync and xchain-explorer copies. They
 * fix leaf order, leaf preimages and domain prefixes, so a one-sided edit makes
 * wallets reject valid indexer proofs. The indexer's suite already compares
 * every carrier; that alone lets an edit made HERE pass SDK CI and the publish
 * workflow and reach npm (src/ is in the publish allowlist) before any indexer
 * venue runs.
 *
 * TWO LAYERS, and the first exists because the second can skip:
 *   1. a GOLDEN sha256 over this repo's own copies, which runs in a standalone
 *      checkout and in the publish workflow; and
 *   2. sibling reads proving the canonical indexer copies (and the sync and
 *      explorer copies when present) agree byte-for-byte.
 * Set XCHAIN_REQUIRE_SIBLINGS=1 to turn a missing sibling into a failure.
 *
 *********************************************************************/

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout.js');

const SDK_SRC = path.resolve(__dirname, '../../..', 'src');
const SIBLING_ROOT = process.env.XCHAIN_SIBLING_ROOT || path.resolve(__dirname, '../../../..');
const INDEXER_ROOT = process.env.XCHAIN_INDEXER_PATH || process.env.XCHAIN_INDEXER_DIR
    || path.join(SIBLING_ROOT, 'xchain-indexer');
const SYNC_ROOT     = process.env.XCHAIN_SYNC_DIR || path.join(SIBLING_ROOT, 'xchain-sync');
const EXPLORER_ROOT = process.env.XCHAIN_EXPLORER_DIR || path.join(SIBLING_ROOT, 'xchain-explorer');

// Each file names this repo's flat path, its golden hash, and every sibling spelling.
const TWINS = [
    { file: 'merkle.js',
      golden: '7147c54c3f9ba76d17584c8e87958ffb29d971d14908e7323e40b61fbe05d500',
      siblings: [
          ['xchain-indexer',  [path.join(INDEXER_ROOT, 'src', 'consensus', 'merkle.js')]],
          ['xchain-sync',     [path.join(SYNC_ROOT, 'src', 'merkle.js')]],
          ['xchain-explorer', [path.join(EXPLORER_ROOT, 'src', 'consensus', 'merkle.js'),
                               path.join(EXPLORER_ROOT, 'src', 'merkle.js')]],
      ] },
    { file: path.join('merkle', 'primitives.js'),
      golden: '0234b9ec6f64126a127003a0b29605d91855f1a5f90197107ad7992b91791f81',
      siblings: [
          ['xchain-indexer',  [path.join(INDEXER_ROOT, 'src', 'consensus', 'merkle', 'primitives.js')]],
          ['xchain-sync',     [path.join(SYNC_ROOT, 'src', 'merkle', 'primitives.js')]],
          ['xchain-explorer', [path.join(EXPLORER_ROOT, 'src', 'consensus', 'merkle', 'primitives.js'),
                               path.join(EXPLORER_ROOT, 'src', 'merkle', 'primitives.js')]],
      ] },
];

function sha256File(p){ return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }

// Pick the first spelling on disk, else the first one, which siblingCheckout then refuses as absent.
function firstPresent(spellings){ return spellings.find((p) => fs.existsSync(p)) || spellings[0]; }

describe('SPV merkle byte layer: consensus twin @regression', function(){

    TWINS.forEach(function(twin){
        it('GOLDEN: src/' + twin.file + ' has not moved on its own', function(){
            // A change here must be a coordinated four-repo change; updating GOLDEN is that step.
            const actual = sha256File(path.join(SDK_SRC, twin.file));
            if(actual !== twin.golden)
                assert.fail('src/' + twin.file + ' changed (sha256 ' + actual + ').\n' +
                    'This file is a consensus file carried byte-identically by xchain-indexer (the ' +
                    'canonical copy, under src/consensus/), xchain-sync, xchain-explorer and xchain-sdk. ' +
                    'Edit the indexer copy, re-vendor every carrier from it, and set GOLDEN to the new ' +
                    'hash in the same change.');
        });
    });
});

describe('SPV merkle byte layer: consensus twin @regression', function(){

    TWINS.forEach(function(twin){
        twin.siblings.forEach(function([repo, spellings]){
            it('src/' + twin.file + ' is byte-identical to the ' + repo + ' copy', function(){
                // Refuse an absent sibling and a lane symlink into a live main checkout alike.
                const verdict = siblingCheckout(__dirname, firstPresent(spellings));
                if(!skipOrFail(this, verdict, 'the ' + repo + ' ' + twin.file + ' merkle twin guard')) return;
                assert.ok(fs.readFileSync(path.join(SDK_SRC, twin.file)).equals(fs.readFileSync(verdict.path)),
                    'MERKLE TWIN DRIFT: xchain-sdk src/' + twin.file + ' differs from ' + verdict.path + '. ' +
                    'These copies define leaf order and leaf preimages, so a split makes wallets reject ' +
                    'valid indexer proofs. Edit the indexer copy and re-vendor; never hand-sync one copy ' +
                    'onto another.');
            });
        });
    });
});
