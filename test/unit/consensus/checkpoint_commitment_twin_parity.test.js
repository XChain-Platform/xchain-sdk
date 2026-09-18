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

// Arms the value claim the CHECKPOINT_COMMITMENT flag day makes across the fleet.
// Since W5 the map is one registry row, checkpoint_commitment_activation
// .CHECKPOINT_COMMITMENT_ACTIVATION, carried by the byte-twin registry parts under
// src/consensus/gate_registry/ in xchain-{hub,indexer,explorer,sdk,sync} and read by
// every consumer through activeAt over the checkpoint's BTC-anchored snapshot_block;
// there is no predicate-only shim carrying it; a one-sided edit to any
// copy's row forks federation quorum verification at the boundary with no CI
// failure, so this guard asserts:
//   1. VALUE     - the sdk row equals the canonical map in xchain-documentation.
//   2. PARITY    - every sibling's registry row equals the sdk row, and its activeAt
//                  agrees with the sdk's at the boundary heights.
// Skips green when the siblings are absent (standalone deploy), unless
// XCHAIN_REQUIRE_SIBLINGS=1.

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const KEY   = 'checkpoint_commitment_activation.CHECKPOINT_COMMITMENT_ACTIVATION';
const local = require('../../../src/consensus/gate_registry');

// GitHub CI checks siblings out beside the repo; fall back to the dev sibling layout.
const SIBLING_ROOT = process.env.XCHAIN_SIBLING_ROOT || path.join(__dirname, '../..', '..', '..');
const DOCS_DIR     = process.env.XCHAIN_DOCS_DIR || path.join(SIBLING_ROOT, 'xchain-documentation');
const CONSTANTS    = path.join(DOCS_DIR, 'protocol', 'constants.js');

const TWINS = ['xchain-hub', 'xchain-indexer', 'xchain-explorer', 'xchain-sync'];
// The registry entry every repo carries at the same tail; the indexer's is the
// consumer-shaped entry over its own protocol_changes parts.
const REGISTRY_ENTRY = path.join('src', 'consensus', 'gate_registry.js');

// The boundary heights the old predicate was pinned at: one below and at the
// mainnet and testnet flag days, regtest genesis, and an unknown network.
const BOUNDARIES = [[960999,'mainnet'],[961000,'mainnet'],[145999,'testnet'],[146000,'testnet'],[0,'regtest'],[5,'bogusnet']];

function missingSibling(what){
    if(process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
        throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but ' + what + ' was not found');
    return null;
}

describe('checkpoint_commitment_activation twin parity @regression', function () {

    it('sdk copy pins the armed flag-days', function () {
        const row = local.copy(KEY);
        assert.strictEqual(row.mainnet, 961000);
        assert.strictEqual(row.testnet, 146000);
        assert.strictEqual(row.regtest, 0);
    });

    it('sdk map is value-identical to the canonical xchain-documentation map', function () {
        if(!fs.existsSync(CONSTANTS)){
            missingSibling('canonical constants at ' + CONSTANTS);
            return this.skip();
        }
        const canon = require(CONSTANTS);
        assert.ok(canon.CHECKPOINT_COMMITMENT_ACTIVATION,
            'constants.js must export CHECKPOINT_COMMITMENT_ACTIVATION (the canonical authority)');
        assert.deepStrictEqual(local.copy(KEY), canon.CHECKPOINT_COMMITMENT_ACTIVATION,
            'sdk row has drifted from the canonical flag-day map; a one-sided edit forks the signed checkpoint.');
    });

    TWINS.forEach(function (repo) {
        it(repo + ' copy matches the sdk copy in value and in bytes', function () {
            const twinPath = path.join(SIBLING_ROOT, repo, REGISTRY_ENTRY);
            if(!fs.existsSync(twinPath)){
                missingSibling(repo + ' sibling registry at ' + twinPath);
                return this.skip();
            }
            const twin = require(twinPath);
            assert.deepStrictEqual(twin.copy(KEY), local.copy(KEY),
                repo + ' activation row diverged from the sdk row');
            for(const [sb, net] of BOUNDARIES){
                assert.strictEqual(twin.activeAt(KEY, net, null, sb, null), local.activeAt(KEY, net, null, sb, null),
                    'predicate parity @ ' + net + ':' + sb);
            }
        });
    });
});
