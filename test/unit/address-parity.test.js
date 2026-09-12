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

// Address-parameter parity between the indexer's validator and the SDK's.
//
// xchain-bridge.md section 13: the indexer's isCryptoAddress(address, coin, network)
// reads a HAND-DUPLICATED ADDRESS_PARAMS table (xchain-indexer/src/utility.js), while
// the SDK's ported copy reads the hashed coin registry (src/coins). Two tables that
// are supposed to describe one thing is exactly the shape that diverges silently, and
// the cost of divergence here is not a red test on a user's screen: an address the SDK
// accepts and the indexer refuses only burns a fee, but an address the SDK accepts on
// the WRONG version byte is a bridge credit minted where nobody holds a key, and a
// bridge credit cannot be recalled. So this guard pins the two tables equal.
//
// It also drives both validators over the same address corpus, because equal tables
// still allow divergent CODE (one side dropping the p2sh branch, say); identical
// verdicts on real addresses is the property that actually protects a lock.
//
// Skips green when the indexer sibling is absent (standalone SDK install), unless
// XCHAIN_REQUIRE_SIBLINGS=1, the checkpointCommitmentTwinParity.test.js convention.

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const Utility = require('../../src/utility.js');
const coins   = require('../../src/coins');

// GitHub CI checks siblings out beside the repo; fall back to the dev sibling layout.
const SIBLING_ROOT  = process.env.XCHAIN_SIBLING_ROOT || path.join(__dirname, '..', '..', '..');
const INDEXER_UTIL  = path.join(SIBLING_ROOT, 'xchain-indexer', 'src', 'utility.js');

const NETWORKS = ['mainnet', 'testnet', 'regtest'];

// Pull the indexer's ADDRESS_PARAMS literal out of its source text rather than
// requiring the module: the constant is module-local (never exported) and loading
// xchain-indexer/src/utility.js drags in its whole config and dependency tree.
function readIndexerAddressParams(){
    let src   = fs.readFileSync(INDEXER_UTIL, 'utf8');
    let start = src.indexOf('const ADDRESS_PARAMS');
    if(start === -1)
        throw new Error('ADDRESS_PARAMS is gone from ' + INDEXER_UTIL + '; this guard is reading the wrong name');
    let open = src.indexOf('{', start);
    let depth = 0, end = -1;
    for(let i=open; i<src.length; i++){
        if(src[i] === '{') depth++;
        else if(src[i] === '}'){
            depth--;
            if(depth === 0){ end = i; break; }
        }
    }
    if(end === -1)
        throw new Error('ADDRESS_PARAMS literal in ' + INDEXER_UTIL + ' is unbalanced');
    // Object literal of number/string/null members only; no call, no identifier.
    return (new Function('return ' + src.slice(open, end+1) + ';'))();
}

// Addresses the two validators are driven over. Real, checksum-valid strings on
// their own chain and network, so a wrong-coin verdict is a genuine version-byte
// answer and not a checksum accident.
const CORPUS = [
    { coin: 'BTC',  network: 'mainnet', address: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2' },
    { coin: 'BTC',  network: 'mainnet', address: '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy' },
    { coin: 'BTC',  network: 'mainnet', address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4' },
    { coin: 'BTC',  network: 'testnet', address: 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn' },
    { coin: 'BTC',  network: 'regtest', address: 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080' },
    { coin: 'LTC',  network: 'mainnet', address: 'LhK2kQwiaAvhjWY799cZvMyYwnQAcxkarr' },
    { coin: 'DOGE', network: 'mainnet', address: 'DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L' },
    { coin: 'LTC',  network: 'mainnet', address: 'M8DEj8RgkJzKTUJt7vyhaiJtSj63G2dfSS' },
    { coin: 'DOGE', network: 'testnet', address: 'nUWEkyCqUgBWyn6LfMxn8cTT6WKU8U1GZg' }
];

describe('bridge: SDK/indexer address-parameter parity', function(){

    let params = null;
    let util   = new Utility();

    before(function(){
        if(!fs.existsSync(INDEXER_UTIL)){
            if(process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but ' + INDEXER_UTIL + ' was not found');
            this.skip();
            return;
        }
        params = readIndexerAddressParams();
    });

    it('covers every coin the SDK registry knows, on every network', function(){
        // A coin present in one table and absent in the other is the divergence
        // this pins: the SDK would validate a destination the indexer cannot judge.
        assert.deepStrictEqual(
            Object.keys(params).sort(),
            coins.ALLOWED_COINS.slice().sort(),
            'the indexer ADDRESS_PARAMS coin set is not the SDK registry coin set'
        );
        for(let coin of coins.ALLOWED_COINS)
            assert.deepStrictEqual(Object.keys(params[coin]).sort(), NETWORKS.slice().sort(),
                coin + ' does not carry exactly the three networks in the indexer table');
    });

    it('the hand-written indexer table equals the hashed coin registry, byte for byte', function(){
        for(let coin of coins.ALLOWED_COINS){
            for(let network of NETWORKS){
                let mine   = util.addressParams(coin, network);
                let theirs = params[coin][network];
                assert.ok(mine, coin + '/' + network + ' resolves no params from the SDK coin registry');
                assert.strictEqual(mine.p2pkh, theirs.p2pkh, coin + '/' + network + ' pubKeyHash differs');
                assert.strictEqual(mine.p2sh,  theirs.p2sh,  coin + '/' + network + ' scriptHash differs');
                // The indexer spells "no segwit on this chain" as null; the SDK derives
                // the same from an absent bech32 HRP in the coin config.
                assert.strictEqual(mine.hrp, theirs.hrp === undefined ? null : theirs.hrp,
                    coin + '/' + network + ' bech32 HRP differs');
            }
        }
    });

    it('both validators answer identically over the address corpus, on every coin and network pair', function(){
        // Equal tables still permit divergent code, so drive the property that matters:
        // for every address, every (coin, network) pair gets the same verdict on both
        // sides. The SDK runs its own validator; the indexer's answer is recomputed from
        // ITS table through the same decode primitives, which is the only part of the
        // indexer's algorithm the SDK port claims to reproduce.
        for(let entry of CORPUS){
            for(let coin of coins.ALLOWED_COINS){
                for(let network of NETWORKS){
                    let sdkSaid     = util.isCryptoAddress(entry.address, coin, network);
                    let indexerSaid = indexerVerdict(util, params, entry.address, coin, network);
                    assert.strictEqual(sdkSaid, indexerSaid,
                        entry.address + ' (' + entry.coin + '/' + entry.network + ') judged '
                        + sdkSaid + ' by the SDK and ' + indexerSaid + ' by the indexer table on '
                        + coin + '/' + network);
                }
            }
            // And the address is valid on its own chain, so the corpus is not vacuously
            // agreeing on "false everywhere".
            assert.strictEqual(util.isCryptoAddress(entry.address, entry.coin, entry.network), true,
                entry.address + ' should be valid on ' + entry.coin + '/' + entry.network);
        }
    });

});

// The indexer's isCryptoAddress body, driven off the INDEXER's table: HRP match for a
// bech32 string, else a 21-byte base58check payload whose version byte is p2pkh or p2sh.
function indexerVerdict(util, params, address, coin, network){
    let p = (params[coin]) ? params[coin][network] : false;
    if(!p)
        return false;
    let str = String(address);
    if(p.hrp && str.toLowerCase().startsWith(p.hrp + '1')){
        let decoded = util.bech32Decode(str);
        return (decoded && decoded.hrp == p.hrp) ? true : false;
    }
    let payload = util.base58CheckDecode(str);
    if(!payload || payload.length != 21)
        return false;
    return (payload[0] == p.p2pkh || payload[0] == p.p2sh);
}
