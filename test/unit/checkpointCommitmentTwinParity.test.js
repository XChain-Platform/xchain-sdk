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
 *********************************************************************/

'use strict';

// Arms the byte-equality claim checkpoint_commitment_activation.js makes in its own
// header ("kept byte-equal by the cross-service regression suite") but that no suite
// enforced. The module gates the SIGNED checkpoint preimage on the BTC-anchored
// snapshot_block and is vendored into xchain-{hub,indexer,explorer,sdk,sync}; a
// one-sided edit to any copy's flag-day forks federation quorum verification at the
// boundary with no CI failure. This guard asserts:
//   1. VALUE   - every copy's map equals the canonical map in xchain-documentation.
//   2. IDENTITY- every copy is byte-identical to the sdk copy apart from the single
//                self-referential header line that names the OTHER copies.
// Mirrors xchain-indexer/test/unit/anchorRewardActivationParity.test.js. Skips green
// when the siblings are absent (standalone deploy), unless XCHAIN_REQUIRE_SIBLINGS=1.

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const MODULE_FILE = 'checkpoint_commitment_activation.js';
const LOCAL_PATH  = path.join(__dirname, '..', '..', 'src', MODULE_FILE);
const local       = require('../../src/' + MODULE_FILE);

// GitHub CI checks siblings out beside the repo; fall back to the dev sibling layout.
const SIBLING_ROOT = process.env.XCHAIN_SIBLING_ROOT || path.join(__dirname, '..', '..', '..');
const DOCS_DIR     = process.env.XCHAIN_DOCS_DIR || path.join(SIBLING_ROOT, 'xchain-documentation');
const CONSTANTS    = path.join(DOCS_DIR, 'protocol', 'constants.js');

const TWINS = ['xchain-hub', 'xchain-indexer', 'xchain-explorer', 'xchain-sync'];

// The one line each copy carries naming the OTHER copies. It is intentionally
// different per copy and is the only permitted divergence.
const TWIN_REF = /live in xchain-\{[^}]*\}/;

function normalized(file){
    return fs.readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .map(l => TWIN_REF.test(l) ? '<TWIN-REF>' : l)
        .join('\n');
}

function missingSibling(what){
    if(process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
        throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but ' + what + ' was not found');
    return null;
}

describe('checkpoint_commitment_activation twin parity @regression', function () {

    it('sdk copy pins the armed flag-days', function () {
        assert.strictEqual(local.CHECKPOINT_COMMITMENT_ACTIVATION.mainnet, 961000);
        assert.strictEqual(local.CHECKPOINT_COMMITMENT_ACTIVATION.testnet, 146000);
        assert.strictEqual(local.CHECKPOINT_COMMITMENT_ACTIVATION.regtest, 0);
    });

    it('sdk map is value-identical to the canonical xchain-documentation map', function () {
        if(!fs.existsSync(CONSTANTS)){
            missingSibling('canonical constants at ' + CONSTANTS);
            return this.skip();
        }
        const canon = require(CONSTANTS);
        assert.ok(canon.CHECKPOINT_COMMITMENT_ACTIVATION,
            'constants.js must export CHECKPOINT_COMMITMENT_ACTIVATION (the canonical authority)');
        assert.deepStrictEqual(local.CHECKPOINT_COMMITMENT_ACTIVATION, canon.CHECKPOINT_COMMITMENT_ACTIVATION,
            'sdk copy has drifted from the canonical flag-day map; a one-sided edit forks the signed checkpoint.');
    });

    TWINS.forEach(function (repo) {
        it(repo + ' copy matches the sdk copy in value and in bytes', function () {
            const twinPath = path.join(SIBLING_ROOT, repo, 'src', MODULE_FILE);
            if(!fs.existsSync(twinPath)){
                missingSibling(repo + ' sibling copy at ' + twinPath);
                return this.skip();
            }
            const twin = require(twinPath);
            assert.deepStrictEqual(twin.CHECKPOINT_COMMITMENT_ACTIVATION, local.CHECKPOINT_COMMITMENT_ACTIVATION,
                repo + ' activation map diverged from the sdk copy');
            for(const [sb, net] of [[960999,'mainnet'],[961000,'mainnet'],[145999,'testnet'],[146000,'testnet'],[0,'regtest'],[5,'bogusnet']]){
                assert.strictEqual(twin.isCheckpointCommitmentActive(sb, net), local.isCheckpointCommitmentActive(sb, net),
                    'predicate parity @ ' + net + ':' + sb);
            }
            assert.strictEqual(normalized(twinPath), normalized(LOCAL_PATH),
                MODULE_FILE + ' drifted between xchain-sdk and ' + repo + ' (only the "live in xchain-{...}" line may differ)');
        });
    });
});
