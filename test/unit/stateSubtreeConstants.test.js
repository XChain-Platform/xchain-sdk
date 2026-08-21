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
            // Testnet armed at genesis 2026-08-20, replacing BTC:testnet's 146500 (left
            // inert by the 2026-08-10 re-genesis) and adding LTC and DOGE, which had no
            // entry at all and so were pinned by nothing before this line.
            { 'BTC:regtest': 10000, 'BTC:testnet': 0, 'LTC:testnet': 0, 'DOGE:testnet': 0 });
        assert.deepStrictEqual(SUB.ESCROW_LOCKED_LEAF_ACTIVATION,
            // Testnet armed at genesis 2026-08-18 (pre-launch: every feature live on testnet).
            { 'BTC:regtest': 11200, 'BTC:testnet': 0, 'LTC:testnet': 0, 'DOGE:testnet': 0 });
        // THE SHADOW MAPS ARE PINNED TOO, and they were not until A
        // shadow commits nothing, which is exactly why it looked safe to leave
        // unasserted here; the cost showed up on 2026-08-11, when the escrow
        // window opened on BTC:testnet and every assertion in this file stayed
        // green except the GOLDEN pin, which then rode into HEAD stale. A client
        // still READS these maps (isEscrowLockedLeafShadowActive is exported), so
        // an unreviewed entry is a client-visible change either way.
        assert.deepStrictEqual(SUB.STATE_SUBTREE_SHADOW,
            { ownership_root: {}, tokens_root: {}, contract_state_root: {} });
        assert.deepStrictEqual(SUB.ESCROW_LOCKED_LEAF_SHADOW, {});
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

    it('no escrow shadow window is open, so a client never computes a leaf twice', function(){
        // The map is empty. The BTC:testnet entry that sat at 148000 was dead the
        // moment the leaf armed at genesis on all three testnets: ARMED WINS over a
        // shadow, so the predicate answered false on BOTH sides of its own threshold
        // while the surrounding prose still read as though a window were open. The
        // heights it straddled are checked explicitly, so re-adding it fails here.
        assert.strictEqual(SUB.isEscrowLockedLeafShadowActive(147999, 'testnet', 'BTC'), false);
        assert.strictEqual(SUB.isEscrowLockedLeafShadowActive(148000, 'testnet', 'BTC'), false);
        // The property this case exists for is that A SHADOW IS NOT AN ARMING, so a
        // client can never accept a locked-balance proof at a height whose balances_root
        // does not cover the XCHAIN_ESC domain (the §4 mistake this file prevents).
        // MAINNET is where that assertion still has teeth: it carries no arming at all.
        assert.strictEqual(SUB.isEscrowLockedLeafActive(999999999, 'mainnet', 'BTC'), false);
        // The committed side on testnet, which is what a client acts on now.
        for(const coin of ['BTC', 'LTC', 'DOGE'])
            for(const h of [0, 147999, 148000, 999999999]){
                assert.strictEqual(SUB.isEscrowLockedLeafActive(h, 'testnet', coin), true,
                    coin + ':testnet locked leaf must be live at ' + h);
                assert.strictEqual(SUB.stateRootVersion(h, 'testnet', coin), 2);
            }
        // Nothing shadows, on either axis, at any height. Sweeping without a carve-out
        // is the point: the predicate must be false because the MAP is empty, not
        // because one chain happens to be armed over it.
        for(const coin of ['BTC', 'LTC', 'DOGE'])
            for(const network of ['mainnet', 'testnet', 'regtest'])
                for(const h of [0, 1, 148000, 999999999])
                    assert.strictEqual(SUB.isEscrowLockedLeafShadowActive(h, network, coin), false,
                        'escrow shadow leaked to ' + coin + '/' + network + '@' + h);
        // A permanently-false predicate would pass every assertion above, so prove the
        // shadow path still WORKS on a scratch chain nothing else touches, including
        // the armed-wins handover that keeps each height on exactly one column.
        const had        = Object.prototype.hasOwnProperty.call(SUB.ESCROW_LOCKED_LEAF_SHADOW, 'DOGE:regtest');
        const prior      = SUB.ESCROW_LOCKED_LEAF_SHADOW['DOGE:regtest'];
        const hadArmed   = Object.prototype.hasOwnProperty.call(SUB.ESCROW_LOCKED_LEAF_ACTIVATION, 'DOGE:regtest');
        const priorArmed = SUB.ESCROW_LOCKED_LEAF_ACTIVATION['DOGE:regtest'];
        try {
            SUB.ESCROW_LOCKED_LEAF_SHADOW['DOGE:regtest']     = 500;
            SUB.ESCROW_LOCKED_LEAF_ACTIVATION['DOGE:regtest'] = 800;
            assert.strictEqual(SUB.isEscrowLockedLeafShadowActive(499, 'regtest', 'DOGE'), false);
            assert.strictEqual(SUB.isEscrowLockedLeafShadowActive(500, 'regtest', 'DOGE'), true);
            assert.strictEqual(SUB.isEscrowLockedLeafShadowActive(799, 'regtest', 'DOGE'), true);
            assert.strictEqual(SUB.isEscrowLockedLeafShadowActive(800, 'regtest', 'DOGE'), false, 'armed wins');
            // Shadowing never moves the derived version: it is not committed.
            assert.strictEqual(SUB.stateRootVersion(600, 'regtest', 'DOGE'), 1);
            assert.strictEqual(SUB.stateRootVersion(800, 'regtest', 'DOGE'), 2);
        } finally {
            // RESTORE, never delete: DOGE:regtest is absent from both real maps, so
            // delete IS the restore here, but it is written as a restore so that
            // arming the chain for real later cannot turn this cleanup into a disarm.
            if(had) SUB.ESCROW_LOCKED_LEAF_SHADOW['DOGE:regtest'] = prior;
            else delete SUB.ESCROW_LOCKED_LEAF_SHADOW['DOGE:regtest'];
            if(hadArmed) SUB.ESCROW_LOCKED_LEAF_ACTIVATION['DOGE:regtest'] = priorArmed;
            else delete SUB.ESCROW_LOCKED_LEAF_ACTIVATION['DOGE:regtest'];
        }
        assert.deepStrictEqual(SUB.ESCROW_LOCKED_LEAF_SHADOW, {}, 'the scratch window was not cleaned up');
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
                    // stateRootVersion is 2 when ANY reserved slot OR the escrow leaf is live, so this
                    // expectation must consider both or it under-predicts on an escrow-armed chain.
                    const escrowArmed = SUB.isEscrowLockedLeafActive(h, network, coin);
                    assert.strictEqual(SUB.stateRootVersion(h, network, coin), (armed || escrowArmed) ? 2 : 1);
                }
        // A CLIENT reading this map is what tells it the slot is live at all, so
        // the boundary it will act on is pinned here too. BTC:regtest at 10000 is the
        // only real below/at/above boundary this slot still has, every testnet chain
        // having armed at genesis, so this is what proves the client's copy can answer
        // false on an armed chain rather than reading as blanket-on.
        assert.strictEqual(SUB.isSubtreeActive('contract_state_root', 0,     'regtest', 'BTC'), false);
        assert.strictEqual(SUB.isSubtreeActive('contract_state_root', 9999,  'regtest', 'BTC'), false);
        assert.strictEqual(SUB.isSubtreeActive('contract_state_root', 10000, 'regtest', 'BTC'), true);
        // The genesis-armed side: a client must report the slot live from block 0 on
        // all three testnet chains, or it tells its user a live slot is inert, which
        // §4 calls the same wrong answer as shipping no export at all.
        for(const coin of ['BTC', 'LTC', 'DOGE'])
            for(const h of [0, 1, 999999999])
                assert.strictEqual(SUB.isSubtreeActive('contract_state_root', h, 'testnet', coin), true,
                    coin + ':testnet must read live to a client at ' + h);
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
        // The sibling armed heights must survive a scratch-arm too. Checked with
        // hasOwnProperty as well as by value: a genesis height is 0, and a bare
        // truthiness check on 0 would read a DELETED key as if it were still armed,
        // which is precisely the disarm this block's restore exists to catch.
        for(const coin of ['BTC', 'LTC', 'DOGE']){
            const k = coin + ':testnet';
            assert.ok(Object.prototype.hasOwnProperty.call(SUB.STATE_SUBTREE_ACTIVATION.contract_state_root, k),
                k + ' was dropped from the map by a scratch-arm');
            assert.strictEqual(SUB.STATE_SUBTREE_ACTIVATION.contract_state_root[k], 0);
        }
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
        // Moved 2026-08-18: ESCROW_LOCKED_LEAF_ACTIVATION armed at genesis on BTC/LTC/DOGE
        // testnet for the pre-launch "every feature live on testnet" ruling. All four copies
        // (indexer, sync, sdk, explorer) were updated in the same change, which is exactly
        // what this pin exists to force.
        // Moved 2026-08-20 (Stage A genesis): STATE_SUBTREE_ACTIVATION.contract_state_root
        // armed at genesis on all three testnet chains, replacing BTC:testnet's 146500 (left
        // inert by the 2026-08-10 re-genesis) and adding LTC and DOGE. Legal at 0 because all
        // three are genesis-active in state_key_collation_activation.js, so no slot arms below
        // its own collation height. ESCROW_LOCKED_LEAF_SHADOW emptied in the same change: its
        // BTC:testnet 148000 entry could never open once the leaf armed at genesis there, so
        // it was unreachable code that read as an open window.
        const GOLDEN = 'fd480996a1c082f7c4024187eb9d05d7e99d8fada1816d7a6a5d978c6e10aa72';
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
