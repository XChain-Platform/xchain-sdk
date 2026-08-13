/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * The client-facing sub-tree activation constants (SPV sub-tree spec §3,
 * Stage A).
 *
 * WHY THE SDK CARRIES THESE AT ALL. No proof can tell a client whether an
 * extension slot is live: an armed-but-empty slot and an inert slot commit the
 * byte-identical EMPTY_SMT_ROOT (spec §2), so a sub_root_path EMPTY proof and a
 * balances-tree absence proof both establish "empty or inert" and never which.
 * The activation maps are the ONLY liveness source, so they ship as consensus
 * constants. A client that treats extension-domain non-inclusion at a height
 * whose arming status it cannot establish as "absent" is making exactly the
 * mistake spec §4 forbids, and without this export it has no way not to.
 *
 * WHY BYTE-IDENTICAL RATHER THAN VALUE-EQUAL. The work list asked only for
 * value-equality on the map contents ("the files differ, the heights must not").
 * The module has no requires and no server-only dependencies, so an identical
 * third copy costs nothing and is strictly stronger: it also pins the PARSING
 * (the strict-height rule, the coin-qualified-key-only lookup, the fail-closed
 * behaviour), and a client that reads the maps with looser rules than the fleet
 * can conclude a slot is armed at a height where the chain says it is not.
 *
 * TWO LAYERS, and the first exists because the second can skip:
 *   1. a GOLDEN pin over this repo's own copy, which runs in a standalone
 *      checkout, so a one-sided edit here reddens SDK CI immediately; and
 *   2. sibling reads proving the indexer and sync copies agree byte-for-byte.
 * Set XCHAIN_REQUIRE_SIBLINGS=1 (the monorepo drift job) to turn a missing
 * sibling into a hard failure instead of a skip, so layer 2 cannot pass
 * green-by-skip where it is meant to run.
 *
 *********************************************************************/

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const SUB = require('../../src/state_subtree_activation.js');
const M   = require('../../src/merkle.js');

const SELF = path.resolve(__dirname, '../../src/state_subtree_activation.js');
const SIBLINGS = {
    'xchain-indexer':  path.resolve(__dirname, '../../..', 'xchain-indexer/src/state_subtree_activation.js'),
    'xchain-sync':     path.resolve(__dirname, '../../..', 'xchain-sync/src/state_subtree_activation.js'),
    'xchain-explorer': path.resolve(__dirname, '../../..', 'xchain-explorer/src/state_subtree_activation.js')
};
const SIBLING_REQUIRED = process.env.XCHAIN_REQUIRE_SIBLINGS === '1';

function sha256File(p){ return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }

describe('SPV sub-tree activation constants: client export @regression', function(){

    it('the maps carry EXACTLY the fleet-armed set, and NOTHING on mainnet', function(){
        // Arming is a fleet code change that deploys before the height is reached.
        // A height arriving via an SDK release alone would tell clients a slot is
        // live on a chain whose indexers still commit it EMPTY, so this pins the
        // set exactly rather than asserting emptiness (which had to be relaxed the
        // moment the fleet armed anything) or nothing (which would let a stray
        // height ride out to clients unnoticed).
        assert.deepStrictEqual(SUB.STATE_SUBTREE_ACTIVATION.ownership_root, {});
        assert.deepStrictEqual(SUB.STATE_SUBTREE_ACTIVATION.tokens_root, {});
        assert.deepStrictEqual(SUB.STATE_SUBTREE_ACTIVATION.contract_state_root,
            { 'BTC:regtest': 10000, 'BTC:testnet': 146500 });
        assert.deepStrictEqual(SUB.ESCROW_LOCKED_LEAF_ACTIVATION, { 'BTC:regtest': 11200 });
        // THE SHADOW MAPS ARE PINNED TOO, and they were not until A
        // shadow commits nothing, which is exactly why it looked safe to leave
        // unasserted here; the cost showed up on 2026-08-11, when the escrow
        // window opened on BTC:testnet and every assertion in this file stayed
        // green except the GOLDEN pin, which then rode into HEAD stale. A client
        // still READS these maps (isEscrowLockedLeafShadowActive is exported), so
        // an unreviewed entry is a client-visible change either way.
        assert.deepStrictEqual(SUB.STATE_SUBTREE_SHADOW,
            { ownership_root: {}, tokens_root: {}, contract_state_root: {} });
        assert.deepStrictEqual(SUB.ESCROW_LOCKED_LEAF_SHADOW, { 'BTC:testnet': 148000 });
        // THE LAUNCH GUARD, and it is about MAINNET rather than about regtest.
        // It read /:regtest$/ while regtest was the only armed network, which was
        // the strictest form available then and the WRONG rule to keep: once the
        // fleet armed BTC:testnet (2026-07-30), a client that refused to carry that
        // height would report a live slot as inert, which §4 calls the same wrong
        // answer as shipping no export at all. The client copy must EQUAL the
        // fleet's. What must never ship armed in a client release is mainnet.
        for(const slot of SUB.RESERVED_SUBTREES)
            for(const key of Object.keys(SUB.STATE_SUBTREE_ACTIVATION[slot]))
                assert.ok(!/:mainnet$/.test(key),
                    slot + ' ships armed on MAINNET (' + key + ') in a CLIENT release');
        for(const key of Object.keys(SUB.ESCROW_LOCKED_LEAF_ACTIVATION))
            assert.ok(!/:mainnet$/.test(key),
                'the escrow leaf ships armed on MAINNET (' + key + ') in a CLIENT release');
        // The mainnet guard covers the shadow maps as well. A mainnet shadow
        // commits nothing either, but it is still a chain nobody has approved
        // appearing in a client release, and the guard is worthless if the
        // easiest way to add a mainnet key is the one it does not look at.
        for(const slot of SUB.RESERVED_SUBTREES)
            for(const key of Object.keys(SUB.STATE_SUBTREE_SHADOW[slot]))
                assert.ok(!/:mainnet$/.test(key),
                    slot + ' ships SHADOWING on MAINNET (' + key + ') in a CLIENT release');
        for(const key of Object.keys(SUB.ESCROW_LOCKED_LEAF_SHADOW))
            assert.ok(!/:mainnet$/.test(key),
                'the escrow leaf ships SHADOWING on MAINNET (' + key + ') in a CLIENT release');
    });

    it('the escrow shadow window opens exactly at 148000 on BTC:testnet, and arms nothing', function(){
        // The boundary a client acts on, driven rather than inferred from the map.
        assert.strictEqual(SUB.isEscrowLockedLeafShadowActive(147999, 'testnet', 'BTC'), false);
        assert.strictEqual(SUB.isEscrowLockedLeafShadowActive(148000, 'testnet', 'BTC'), true);
        // A SHADOW IS NOT AN ARMING, and this is the assertion that says so. If
        // these two ever answer true together, a client would accept a
        // locked-balance proof for a height whose balances_root does not cover
        // the XCHAIN_ESC domain, which is the §4 mistake this file exists to
        // prevent. stateRootVersion must not move across the window either:
        // Stage A is already armed on BTC:testnet at 146500, so 2 on both sides.
        assert.strictEqual(SUB.isEscrowLockedLeafActive(148000, 'testnet', 'BTC'), false);
        assert.strictEqual(SUB.isEscrowLockedLeafActive(999999999, 'testnet', 'BTC'), false);
        assert.strictEqual(SUB.stateRootVersion(147999, 'testnet', 'BTC'), 2);
        assert.strictEqual(SUB.stateRootVersion(148000, 'testnet', 'BTC'), 2);
        // Chain-local, on both axes: no other coin and no other network opens.
        for(const coin of ['BTC', 'LTC', 'DOGE'])
            for(const network of ['mainnet', 'testnet', 'regtest'])
                assert.strictEqual(SUB.isEscrowLockedLeafShadowActive(148000, network, coin),
                    coin === 'BTC' && network === 'testnet',
                    'escrow shadow leaked to ' + coin + '/' + network);
        // A window below the chain's own first indexed block (147500, after the
        // 2026-08-10 re-genesis) would never open at all, so the height is not
        // merely reviewed, it is reachable.
        assert.ok(SUB.ESCROW_LOCKED_LEAF_SHADOW['BTC:testnet'] > 147500,
            'the shadow window must start above BTC:testnet\'s first indexed block');
    });

    it('the slot list matches this repo\'s merkle.STATE_SUBTREES tail', function(){
        // The tail order IS the leaf order of the top-level tree, so a client that
        // disagrees about it verifies sub_root_path against the wrong slot index.
        assert.deepStrictEqual(SUB.RESERVED_SUBTREES, M.STATE_SUBTREES.slice(2));
    });

    it('answers "off" on every INERT chain and height, and "on" only for the armed one', function(){
        for(const coin of ['BTC', 'LTC', 'DOGE'])
            for(const network of ['mainnet', 'testnet', 'regtest'])
                for(const h of [0, 1, 962500, 3160000, 6335000, 999999999]){
                    // Derived from the map, not a hardcoded pair: with two heights
                    // armed a hardcoded chain would assert "off" for a chain that is on.
                    const threshold = SUB.STATE_SUBTREE_ACTIVATION.contract_state_root[coin + ':' + network];
                    const armed = (threshold !== undefined) && h >= threshold;
                    for(const slot of SUB.RESERVED_SUBTREES)
                        assert.strictEqual(SUB.isSubtreeActive(slot, h, network, coin),
                            armed && slot === 'contract_state_root',
                            slot + ' ' + coin + '/' + network + '@' + h);
                    assert.strictEqual(SUB.stateRootVersion(h, network, coin), armed ? 2 : 1);
                }
        // A CLIENT reading this map is what tells it the slot is live at all, so
        // the boundary it will act on is pinned here too.
        assert.strictEqual(SUB.isSubtreeActive('contract_state_root', 9999,  'regtest', 'BTC'), false);
        assert.strictEqual(SUB.isSubtreeActive('contract_state_root', 10000, 'regtest', 'BTC'), true);
    });

    it('a client reading the maps gets the SAME answer the fleet commits (arming is visible)', function(){
        // The export is useless if it cannot report a live slot, so prove the
        // query path opens, then closes again. This is the check that would catch
        // an export accidentally frozen to "always inert".
        const map = SUB.STATE_SUBTREE_ACTIVATION.contract_state_root;
        // SNAPSHOT AND RESTORE, never delete. This helper used to end in
        // `delete map['BTC:regtest']`, which was indistinguishable from a restore
        // while the map was empty and became a silent DISARM the moment a real
        // height existed: every later test in the process would then read the
        // chain as inert. That exact failure cost a debugging session at the
        // Stage A arming and was fixed in four other files; this copy was missed,
        // and the second armed height (BTC:testnet) made it worse still, since a
        // delete here leaves a HALF-armed map behind.
        const had   = Object.prototype.hasOwnProperty.call(map, 'BTC:regtest');
        const prior = map['BTC:regtest'];
        try {
            map['BTC:regtest'] = 500;
            assert.strictEqual(SUB.isSubtreeActive('contract_state_root', 499, 'regtest', 'BTC'), false);
            assert.strictEqual(SUB.isSubtreeActive('contract_state_root', 500, 'regtest', 'BTC'), true);
            assert.strictEqual(SUB.stateRootVersion(500, 'regtest', 'BTC'), 2);
            assert.strictEqual(SUB.stateRootVersion(499, 'regtest', 'BTC'), 1);
            assert.strictEqual(SUB.isSubtreeActive('contract_state_root', 500, 'regtest', 'LTC'), false,
                'chain-local: arming BTC must not arm LTC for a client either');
        } finally {
            if(had) map['BTC:regtest'] = prior; else delete map['BTC:regtest'];
        }
        // The assertion that catches a regression in the restore itself.
        assert.strictEqual(map['BTC:regtest'], 10000, 'restored to the real armed height, not wiped');
        assert.strictEqual(SUB.STATE_SUBTREE_ACTIVATION.contract_state_root['BTC:testnet'], 146500,
            'the sibling armed height must survive a scratch-arm too');
    });

    it('GOLDEN: this repo\'s copy has not moved on its own', function(){
        // Layer 1. A bump anywhere must be a coordinated four-repo change; this
        // pin makes a one-sided edit HERE fail even with no siblings on disk.
        // Updating it is the deliberate step that says "yes, all four moved".
        // 2026-07-28 (B2): the explorer became the fourth carrier (its
        // locked-balance proof endpoint refuses below the escrow leaf's armed
        // height, and only this map can tell it where that is) and the
        // ESCROW_LOCKED_LEAF comment block was refreshed to the built design.
        // 2026-07-28 (B3): ESCROW_LOCKED_LEAF_SHADOW + its armed-wins
        // predicate landed for the §7 shadow window.
        // 2026-07-28 (arming): contract_state_root ARMED on BTC:regtest at
        // 10000, the first height ever set in this file. Regtest only; mainnet and
        // testnet remain unarmed for every slot.
        // 2026-07-30 (testnet arming): contract_state_root ARMED on
        // BTC:testnet at 146500, above its 146000 collation height. BTC only of the
        // three testnet chains (LTC:testnet is below its own collation height,
        // DOGE:testnet has no follower). MAINNET still unarmed for every slot.
        // 2026-08-11 (Stage B shadow): ESCROW_LOCKED_LEAF_SHADOW
        // opened on BTC:testnet at 148000. A SHADOW, not an arming: nothing is
        // committed, balances_root stays byte-identical to v1, and every
        // locked-balance proof stays refused because ESCROW_LOCKED_LEAF_ACTIVATION
        // is what both gates read and it did not move.
        // 2026-08-12: this pin was the ONLY thing that caught the line
        // above, and it caught it one commit late, so it landed red at HEAD. The
        // shadow maps had no assertion of their own in this file, which is why the
        // exact-set tripwire stayed green through a real map change; that hole is
        // closed in the first test above, and this pin is now the SECOND line of
        // defence it was always meant to be rather than the only one.
        // Re-pinned 2026-08-12 onto the shadow-map change described just above,
        // which is the change this pin caught a commit late. All four carriers
        // were verified byte-identical and unmodified at HEAD before repinning,
        // so the invariant the pin guards holds; only the pin was stale.
        const GOLDEN = '7c69cad798e79c8a7fe37bc9b379819dc963d6bfee7928ff0c7fee531989bda6';
        const actual = sha256File(SELF);
        if(actual !== GOLDEN)
            assert.fail('src/state_subtree_activation.js changed (sha256 ' + actual + ').\n' +
                'This file is a consensus constant carried byte-identically by xchain-indexer, ' +
                'xchain-sync, xchain-sdk and xchain-explorer. If this change is intended, update ' +
                'ALL FOUR copies and set GOLDEN to the new hash in the same commit.');
    });

    Object.keys(SIBLINGS).forEach(function(repo){
        it('is byte-identical to ' + repo + '\'s copy (cross-repo consensus constant)', function(){
            if(!fs.existsSync(SIBLINGS[repo])){
                if(SIBLING_REQUIRED)
                    throw new Error('drift guard cannot run: sibling missing at ' + SIBLINGS[repo]);
                return this.skip();
            }
            assert.strictEqual(fs.readFileSync(SELF, 'utf8'), fs.readFileSync(SIBLINGS[repo], 'utf8'),
                'state_subtree_activation.js drifted between xchain-sdk and ' + repo + '. The heights a ' +
                'client reads MUST equal the heights the fleet commits: a lagging SDK copy reports a live ' +
                'slot as inert, which is the same wrong answer as shipping no export at all.');
        });
    });
});
