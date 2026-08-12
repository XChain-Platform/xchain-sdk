// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect } = require('chai');
const AddressResolver = require('../../src/addressResolver.js');
const Utility = require('../../src/utility.js');

// A real, indexable address per chain (regtest BTC P2PKH-style sample).
const ADDR  = 'mxchaintestaddressXXXXXXXXXXXX1a8EAfp';
const ADDR2 = 'n2eMqTT929pb1RDNuqEnxdaLau1rxy3efi';

// Minimal fake SDK exposing only what AddressResolver touches.
function makeSdk(opts = {}, getAddress = null) {
    return {
        options: opts.options || {},
        util: new Utility(),
        explorer: getAddress
            ? { getAddress }
            : (opts.noExplorer ? null : { getAddress: async () => { throw new Error('not stubbed'); } })
    };
}

// Build a getAddress stub mapping address -> address_id, throwing for unknown
// addresses (mirrors the explorer 404ing on an address with no index id).
function addressStub(map) {
    return async (address) => {
        if (!(address in map)) throw new Error('404 address not found');
        return { info: { address: address, address_id: map[address] } };
    };
}

describe('AddressResolver', function () {

    describe('resolve()', function () {

        it('rewrites a known address to its ^<id> form', async function () {
            const r = new AddressResolver(makeSdk({}, addressStub({ [ADDR]: 57 })));
            expect(await r.resolve(ADDR)).to.equal('^57');
        });

        it('passes an already-^id reference through untouched (no lookup)', async function () {
            let called = false;
            const r = new AddressResolver(makeSdk({}, async () => { called = true; return {}; }));
            expect(await r.resolve('^57')).to.equal('^57');
            expect(called).to.equal(false);
        });

        it('passes a contract C:<CHAIN>:<idx> address through untouched (no lookup)', async function () {
            let called = false;
            const r = new AddressResolver(makeSdk({}, async () => { called = true; return {}; }));
            expect(await r.resolve('C:BTC:42')).to.equal('C:BTC:42');
            expect(called).to.equal(false);
        });

        it('passes the BURN sentinel through untouched (no lookup)', async function () {
            let called = false;
            const r = new AddressResolver(makeSdk({}, async () => { called = true; return {}; }));
            expect(await r.resolve('BURN')).to.equal('BURN');
            expect(called).to.equal(false);
        });

        it('falls back to the address when it is not indexed (lookup throws)', async function () {
            const r = new AddressResolver(makeSdk({}, addressStub({ [ADDR]: 57 })));
            expect(await r.resolve(ADDR2)).to.equal(ADDR2);
        });

        it('falls back to the address when no explorer is wired', async function () {
            const r = new AddressResolver(makeSdk({ noExplorer: true }));
            expect(await r.resolve(ADDR)).to.equal(ADDR);
        });

        it('is disabled by { compactAddresses: false }', async function () {
            const r = new AddressResolver(makeSdk({ options: { compactAddresses: false } }, addressStub({ [ADDR]: 57 })));
            expect(await r.resolve(ADDR)).to.equal(ADDR);
        });

        it('caches a resolved id (one lookup for repeated resolves)', async function () {
            let calls = 0;
            const r = new AddressResolver(makeSdk({}, async (a) => { calls++; return { info: { address_id: 57 } }; }));
            expect(await r.resolve(ADDR)).to.equal('^57');
            expect(await r.resolve(ADDR)).to.equal('^57');
            expect(calls).to.equal(1);
        });
    });

    describe('resolveActionParams()', function () {

        // This test used to assert the OPPOSITE, and that is how the
        // defect shipped. SEND declares DESTINATION multi:true, and
        // xchain-indexer/src/actions/send.js is the one address-bearing handler
        // with no resolveAddressRef call, so a compacted destination is rejected
        // on chain as 'invalid: DESTINATION (format)'. Compaction only kicks in
        // once an address HAS an id, and the first send to an address is what
        // assigns it, so the first send to any address worked and every
        // subsequent one failed with the fee spent and the tokens not moved.
        it('never compacts a SEND DESTINATION, single-recipient or not', async function () {
            const r = new AddressResolver(makeSdk({}, addressStub({ [ADDR]: 57 })));
            const out = await r.resolveActionParams('SEND', { tick: 'JDOG', amount: '1', destination: ADDR });
            expect(out.destination).to.equal(ADDR);
            expect(out.tick).to.equal('JDOG');   // non-address field untouched
        });

        // The saving is still taken everywhere the indexer can resolve it, so
        // this is a narrowing of SEND only, not a retreat from compaction.
        it('still compacts MINT DESTINATION, which mint.js does resolve', async function () {
            const r = new AddressResolver(makeSdk({}, addressStub({ [ADDR]: 57 })));
            const out = await r.resolveActionParams('MINT', { tick: 'JDOG', amount: '1', destination: ADDR });
            expect(out.destination).to.equal('^57');
        });

        it('leaves an array (multi-recipient) DESTINATION uncompacted', async function () {
            const r = new AddressResolver(makeSdk({}, addressStub({ [ADDR]: 57, [ADDR2]: 58 })));
            const out = await r.resolveActionParams('SEND', { destination: [ADDR, ADDR2] });
            expect(out.destination).to.deep.equal([ADDR, ADDR2]);
        });

        it('does not mutate the caller params object', async function () {
            const r = new AddressResolver(makeSdk({}, addressStub({ [ADDR]: 57 })));
            const input = { destination: ADDR };
            await r.resolveActionParams('SEND', input);
            expect(input.destination).to.equal(ADDR);
        });

        it('does NOT compact either DISPENSER address field (the decoder cannot resolve ^<id>)', async function () {
            // GET_ADDRESS: the dispenser's operating key, which the decoder gates dispense
            // detection on. ORACLE_ADDRESS: the payee of the PRICE v1 oracle usage fee,
            // whose on-chain output the decoder must capture into transaction_outputs by
            // reading this very field; compacted, nothing is captured and the
            // indexer rejects the create however much was actually paid.
            const r = new AddressResolver(makeSdk({}, addressStub({ [ADDR]: 57, [ADDR2]: 58 })));
            const out = await r.resolveActionParams('DISPENSER', { getAddress: ADDR, oracleAddress: ADDR2 });
            expect(out.getAddress).to.equal(ADDR);
            expect(out.oracleAddress).to.equal(ADDR2);
        });

        it('still compacts ORDER and SWAP GET_ADDRESS (the exemption is DISPENSER-scoped)', async function () {
            const r = new AddressResolver(makeSdk({}, addressStub({ [ADDR]: 57 })));
            const order = await r.resolveActionParams('ORDER', { getAddress: ADDR });
            const swap  = await r.resolveActionParams('SWAP',  { getAddress: ADDR });
            expect(order.getAddress).to.equal('^57');
            expect(swap.getAddress).to.equal('^57');
        });
    });
});
