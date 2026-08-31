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
// FAMILY_SLIP44 shape + cross-repo drift guard.
//
// src/derivation.js is the backend-side anchor for the wallet<->backend
// coin-type parity contract. This suite pins its shape and values, and
// drift-guards each coin type against the wallet HD descriptors at
// xchain-wallet/packages/core/src/registry/descriptors/{bitcoin,litecoin,
// dogecoin}.js (the m/44'/N' purpose path). When the sibling wallet checkout is
// absent the drift guard skips, unless XCHAIN_REQUIRE_SIBLINGS=1 (the job that
// checks out siblings), where it hard-fails rather than green-by-skip.

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const { FAMILY_SLIP44 } = require('../../src/derivation.js');
const { ALLOWED_COINS } = require('../../src/coins/index.js');

// Registered mainnet SLIP-44 coin types; the contract this module anchors.
const EXPECTED = { BTC: 0, LTC: 2, DOGE: 3 };

// The canonical coin registry, sorted, as the coverage target for both key sets
// below. src/coins/index.js documents adding a chain as "drop a <COIN>.js data
// file in this directory and add it to COIN_FILES; nothing else in this file
// changes", so nothing in THIS file may be the thing that has to notice.
const REGISTERED = [...ALLOWED_COINS].sort();

// coin family -> wallet descriptor file whose p2pkh path (m/44'/N') carries the
// authoritative coin type on the other side of the contract.
const WALLET_DESCRIPTORS_DIR = path.join(
    __dirname, '..', '..', '..',
    'xchain-wallet', 'packages', 'core', 'src', 'registry', 'descriptors'
);
const DESCRIPTOR_FILE = { BTC: 'bitcoin.js', LTC: 'litecoin.js', DOGE: 'dogecoin.js' };

const SIBLING_REQUIRED = process.env.XCHAIN_REQUIRE_SIBLINGS === '1';
function requireSibling(ctx, absPath) {
    if (fs.existsSync(absPath)) return true;
    if (SIBLING_REQUIRED)
        throw new Error('derivation parity guard cannot run: required sibling missing at ' +
            absPath + ' (the job setting XCHAIN_REQUIRE_SIBLINGS=1 must check out xchain-wallet)');
    ctx.skip();
    return false;
}

// Pull the SLIP-44 coin type out of the p2pkh derivation path (m/44'/N'/...).
function coinTypeFromDescriptor(fileText) {
    const m = fileText.match(/p2pkh:\s*"m\/44'\/(\d+)'/);
    return m ? Number(m[1]) : null;
}

describe('derivation FAMILY_SLIP44', function () {
    describe('shape and values', function () {
        it('has exactly the BTC/LTC/DOGE coin families', function () {
            assert.deepStrictEqual(Object.keys(FAMILY_SLIP44).sort(), Object.keys(EXPECTED).sort());
        });

        it('pins the registered mainnet SLIP-44 coin types', function () {
            assert.deepStrictEqual(FAMILY_SLIP44, EXPECTED);
        });

        // EXPECTED and DESCRIPTOR_FILE are hand-written, and so was the key set
        // they were checked against, so a fourth coin could land in COIN_FILES
        // and disturb nothing here. That is not a cosmetic gap: the wallet's
        // cross-repo leg iterates Object.entries(FAMILY_SLIP44), so a coin
        // missing from the anchor produces no case there either, and the wallet
        // side stays green against its own constant, which is the one thing
        // src/derivation.js exists to prevent. Bind both key sets to the
        // registry instead.
        it('FAMILY_SLIP44 covers every coin in the SDK coin registry', function () {
            assert.deepStrictEqual(Object.keys(FAMILY_SLIP44).sort(), REGISTERED,
                'FAMILY_SLIP44 drifted from coins.ALLOWED_COINS: add the new coin\'s registered ' +
                'mainnet SLIP-44 coin type to src/derivation.js');
        });

        it('DESCRIPTOR_FILE covers every coin in the SDK coin registry', function () {
            assert.deepStrictEqual(Object.keys(DESCRIPTOR_FILE).sort(), REGISTERED,
                'DESCRIPTOR_FILE drifted from coins.ALLOWED_COINS: add the new coin\'s wallet ' +
                'descriptor filename here, or the cross-repo drift guard below emits no case for it');
        });

        it('every value is a non-negative integer coin type', function () {
            for (const [family, coinType] of Object.entries(FAMILY_SLIP44)) {
                assert.strictEqual(Number.isInteger(coinType), true, family + ' coin type must be an integer');
                assert.ok(coinType >= 0, family + ' coin type must be non-negative');
            }
        });
    });

    describe('cross-repo drift guard vs wallet HD descriptors', function () {
        // Iterate the REGISTRY, not a hand-listed key set: a coin added to
        // COIN_FILES must produce a drift case here or fail the coverage tests
        // above, never silently produce none.
        for (const family of REGISTERED) {
            it(family + ' matches xchain-wallet ' + (DESCRIPTOR_FILE[family] || '<unmapped>') + ' m/44 path', function () {
                assert.ok(DESCRIPTOR_FILE[family],
                    family + ' is in coins.ALLOWED_COINS but has no wallet descriptor mapped in DESCRIPTOR_FILE');
                const file = path.join(WALLET_DESCRIPTORS_DIR, DESCRIPTOR_FILE[family]);
                if (!requireSibling(this, file)) return;
                const coinType = coinTypeFromDescriptor(fs.readFileSync(file, 'utf8'));
                assert.notStrictEqual(coinType, null,
                    'could not extract m/44 coin type from ' + DESCRIPTOR_FILE[family] +
                    ' (descriptor format changed; update this guard)');
                assert.strictEqual(FAMILY_SLIP44[family], coinType,
                    'COIN-TYPE DRIFT: FAMILY_SLIP44.' + family + '=' + FAMILY_SLIP44[family] +
                    ' but wallet descriptor uses m/44\'/' + coinType + '\'');
            });
        }
    });
});
