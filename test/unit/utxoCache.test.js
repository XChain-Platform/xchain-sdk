// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const UTXOCache = require('../../src/utxoCache.js');

describe('UTXOCache', function () {

    let cache;

    beforeEach(function () {
        cache = new UTXOCache();
    });

    /*
     *  Constructor / initial state
     */

    describe('constructor', function () {
        it('starts stale', function () {
            assert.strictEqual(cache.isLoaded(), false);
        });

        it('has no address initially', function () {
            assert.strictEqual(cache.address, null);
        });

        it('hasAvailable() is false before refresh', function () {
            assert.strictEqual(cache.hasAvailable(), false);
        });

        it('getAvailable() returns empty array before refresh', function () {
            assert.deepStrictEqual(cache.getAvailable(), []);
        });
    });

    /*
     *  refresh()
     */

    describe('refresh()', function () {
        it('loads utxos from encoder.getUTXOs result.utxos', async function () {
            let encoder = {
                getUTXOs: async () => ({ utxos: [{ txid: 'aaaa', vout: 0, value: 100000 }] })
            };
            let result = await cache.refresh('addr1', encoder);
            assert.strictEqual(result.length, 1);
            assert.strictEqual(result[0].txid, 'aaaa');
            assert.strictEqual(cache.isLoaded(), true);
            assert.strictEqual(cache.address, 'addr1');
        });

        it('loads utxos when encoder returns bare array', async function () {
            let encoder = {
                getUTXOs: async () => [{ txid: 'bbbb', vout: 1, value: 50000 }]
            };
            let result = await cache.refresh('addr2', encoder);
            assert.strictEqual(result.length, 1);
            assert.strictEqual(result[0].txid, 'bbbb');
        });

        it('treats an undefined result as no-UTXOs instead of throwing (malformed response)', async function () {
            // _rpc returns body.result, which is undefined for an empty/result-less
            // encoder response; refresh must not crash on `result.utxos`.
            let encoder = { getUTXOs: async () => undefined };
            let result = await cache.refresh('addrX', encoder);
            assert.deepStrictEqual(result, []);
            assert.strictEqual(cache.hasAvailable(), false);
            assert.strictEqual(cache.isLoaded(), true);
        });

        it('treats a null result as no-UTXOs', async function () {
            let encoder = { getUTXOs: async () => null };
            let result = await cache.refresh('addrY', encoder);
            assert.deepStrictEqual(result, []);
        });

        it('treats an error-shaped object (no .utxos array) as no-UTXOs', async function () {
            let encoder = { getUTXOs: async () => ({ error: 'boom' }) };
            let result = await cache.refresh('addrZ', encoder);
            assert.deepStrictEqual(result, []);
            // getAvailable must not throw on a non-array cache.
            assert.deepStrictEqual(cache.getAvailable(), []);
        });

        it('resets state when address changes', async function () {
            let encoder1 = { getUTXOs: async () => ({ utxos: [{ txid: 'tx1', vout: 0, value: 1 }] }) };
            await cache.refresh('addr1', encoder1);
            cache.markSpent([{ txid: 'tx1', vout: 0 }]);
            assert.strictEqual(cache.getAvailable().length, 0);

            let encoder2 = { getUTXOs: async () => ({ utxos: [{ txid: 'tx2', vout: 0, value: 2 }] }) };
            await cache.refresh('addr2', encoder2);
            // Spent set cleared; tx2 should be available
            assert.strictEqual(cache.getAvailable().length, 1);
            assert.strictEqual(cache.address, 'addr2');
        });

        it('does NOT reset state when same address is refreshed', async function () {
            let encoder = { getUTXOs: async () => ({ utxos: [{ txid: 'tx1', vout: 0, value: 1 }] }) };
            await cache.refresh('addr1', encoder);
            cache.markSpent([{ txid: 'tx1', vout: 0 }]);

            // refresh same address; spent set should be preserved
            let encoder2 = { getUTXOs: async () => ({ utxos: [{ txid: 'tx2', vout: 0, value: 2 }] }) };
            await cache.refresh('addr1', encoder2);
            // tx1 still marked spent, tx2 available
            assert.strictEqual(cache.getAvailable().length, 1);
        });

        it('removes confirmed speculative UTXOs after refresh', async function () {
            let encoder1 = { getUTXOs: async () => ({ utxos: [] }) };
            await cache.refresh('addr1', encoder1);
            cache.addSpeculative({ txid: 'spec1', vout: 0, value: 9999 });
            assert.strictEqual(cache.getAvailable().length, 1);

            // Next refresh: spec1 is now confirmed
            let encoder2 = { getUTXOs: async () => ({ utxos: [{ txid: 'spec1', vout: 0, value: 9999 }] }) };
            await cache.refresh('addr1', encoder2);
            // speculative list pruned, but still in _utxos; only 1 result (not 2)
            assert.strictEqual(cache.getAvailable().length, 1);
        });

        it('returns empty array when encoder returns empty utxos', async function () {
            let encoder = { getUTXOs: async () => ({ utxos: [] }) };
            let result = await cache.refresh('addr1', encoder);
            assert.deepStrictEqual(result, []);
            assert.strictEqual(cache.isLoaded(), true);
            assert.strictEqual(cache.hasAvailable(), false);
        });
    });

    /*
     *  getAvailable()
     */

    describe('getAvailable()', function () {
        it('includes both confirmed and speculative UTXOs', async function () {
            let encoder = { getUTXOs: async () => ({ utxos: [{ txid: 'c1', vout: 0, value: 1 }] }) };
            await cache.refresh('addr1', encoder);
            cache.addSpeculative({ txid: 's1', vout: 0, value: 2 });
            let avail = cache.getAvailable();
            assert.strictEqual(avail.length, 2);
        });

        it('excludes spent UTXOs', async function () {
            let encoder = {
                getUTXOs: async () => ({
                    utxos: [
                        { txid: 'tx1', vout: 0, value: 1 },
                        { txid: 'tx2', vout: 1, value: 2 }
                    ]
                })
            };
            await cache.refresh('addr1', encoder);
            cache.markSpent([{ txid: 'tx1', vout: 0 }]);
            let avail = cache.getAvailable();
            assert.strictEqual(avail.length, 1);
            assert.strictEqual(avail[0].txid, 'tx2');
        });

        it('excludes spent speculative UTXOs', async function () {
            let encoder = { getUTXOs: async () => ({ utxos: [] }) };
            await cache.refresh('addr1', encoder);
            cache.addSpeculative({ txid: 'spec1', vout: 0, value: 1 });
            cache.markSpent([{ txid: 'spec1', vout: 0 }]);
            assert.strictEqual(cache.getAvailable().length, 0);
        });
    });

    /*
     *  markSpent()
     */

    describe('markSpent()', function () {
        it('marks multiple inputs spent', async function () {
            let encoder = {
                getUTXOs: async () => ({
                    utxos: [
                        { txid: 'a', vout: 0, value: 1 },
                        { txid: 'b', vout: 0, value: 2 },
                        { txid: 'c', vout: 0, value: 3 }
                    ]
                })
            };
            await cache.refresh('addr1', encoder);
            cache.markSpent([{ txid: 'a', vout: 0 }, { txid: 'b', vout: 0 }]);
            assert.strictEqual(cache.getAvailable().length, 1);
            assert.strictEqual(cache.getAvailable()[0].txid, 'c');
        });

        it('is a no-op when called with null/undefined', function () {
            assert.doesNotThrow(() => cache.markSpent(null));
            assert.doesNotThrow(() => cache.markSpent(undefined));
        });

        it('handles empty array', function () {
            assert.doesNotThrow(() => cache.markSpent([]));
        });
    });

    /*
     *  addSpeculative()
     */

    describe('addSpeculative()', function () {
        it('adds a speculative UTXO', function () {
            cache.addSpeculative({ txid: 'new', vout: 0, value: 5000 });
            // even without refresh, speculative UTXOs appear in getAvailable
            assert.strictEqual(cache.getAvailable().length, 1);
        });

        it('ignores null utxo', function () {
            assert.doesNotThrow(() => cache.addSpeculative(null));
            assert.strictEqual(cache.getAvailable().length, 0);
        });

        it('ignores utxo without txid', function () {
            assert.doesNotThrow(() => cache.addSpeculative({ vout: 0 }));
            assert.strictEqual(cache.getAvailable().length, 0);
        });
    });

    /*
     *  invalidate()
     */

    describe('invalidate()', function () {
        it('clears everything and marks stale', async function () {
            let encoder = { getUTXOs: async () => ({ utxos: [{ txid: 'tx1', vout: 0, value: 1 }] }) };
            await cache.refresh('addr1', encoder);
            cache.markSpent([{ txid: 'tx1', vout: 0 }]);
            cache.addSpeculative({ txid: 'spec', vout: 0, value: 2 });

            cache.invalidate();

            assert.strictEqual(cache.isLoaded(), false);
            assert.strictEqual(cache.getAvailable().length, 0);
            // address is preserved so next refresh doesn't clear it
        });

        it('hasAvailable() returns false after invalidate', async function () {
            let encoder = { getUTXOs: async () => ({ utxos: [{ txid: 'tx1', vout: 0, value: 1 }] }) };
            await cache.refresh('addr1', encoder);
            assert.strictEqual(cache.hasAvailable(), true);
            cache.invalidate();
            assert.strictEqual(cache.hasAvailable(), false);
        });
    });

    /*
     *  address getter
     */

    describe('address getter', function () {
        it('returns address set during refresh', async function () {
            let encoder = { getUTXOs: async () => ({ utxos: [] }) };
            await cache.refresh('my-addr', encoder);
            assert.strictEqual(cache.address, 'my-addr');
        });
    });

});
