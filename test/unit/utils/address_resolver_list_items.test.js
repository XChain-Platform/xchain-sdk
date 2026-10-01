// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const { expect } = require('chai');
const AddressResolver = require('../../../src/utils/address_resolver.js');
const Utility = require('../../../src/utils/utility.js');

const ADDR1 = 'mxchaintestaddressXXXXXXXXXXXX1a8EAfp';
const ADDR2 = 'n2eMqTT929pb1RDNuqEnxdaLau1rxy3efi';
const UNKNOWN = 'munknownAddressXXXXXXXXXXXXXXXXXX1';

function setup(overrides = {}) {
    const calls = { status: 0, action: [], address: [] };
    const ids = Object.assign({ [ADDR1]: 57, [ADDR2]: 58 }, overrides.ids);
    const coin = overrides.coin || 'RBTC';
    const explorer = {
        coin,
        getStatus: async () => {
            calls.status += 1;
            if (overrides.statusError) throw new Error('status unavailable');
            return { last_block: { [coin]: overrides.lastBlock === undefined ? 5 : overrides.lastBlock } };
        },
        getAction: async (index) => {
            calls.action.push(index);
            if (overrides.actionError) throw new Error('parent unavailable');
            return { data: [{ action: 'LIST', type: overrides.parentType }] };
        },
        getAddress: async (address) => {
            calls.address.push(address);
            if (!Object.prototype.hasOwnProperty.call(ids, address))
                throw new Error('404 address not found');
            return { info: { address_id: ids[address] } };
        }
    };
    const sdk = {
        options: overrides.options || {},
        config: { network: overrides.network || 'bitcoin-regtest' },
        util: new Utility(),
        explorer
    };
    return { resolver: new AddressResolver(sdk), explorer, calls };
}

describe('AddressResolver LIST items', function () {
    it('compacts known TYPE 2 create items on regtest and keeps unknown items', async function () {
        const { resolver, calls } = setup();
        const input = { TYPE: 2, ITEM: [ADDR1, UNKNOWN, ADDR2] };

        const out = await resolver.resolveActionParams('LIST', input);

        expect(out.ITEM).to.deep.equal(['^57', UNKNOWN, '^58']);
        expect(input.ITEM).to.deep.equal([ADDR1, UNKNOWN, ADDR2]);
        expect(calls.status).to.equal(1);
        expect(calls.address).to.have.members([ADDR1, UNKNOWN, ADDR2]);
    });

    it('reuses successful item lookups from the permanent address cache', async function () {
        const { resolver, calls } = setup();
        const params = { type: '2', item: [ADDR1, ADDR2] };

        expect((await resolver.resolveActionParams('list', params)).item).to.deep.equal(['^57', '^58']);
        expect((await resolver.resolveActionParams('LIST', params)).item).to.deep.equal(['^57', '^58']);
        expect(calls.address).to.deep.equal([ADDR1, ADDR2]);
    });

    it('leaves items untouched on an unarmed mainnet', async function () {
        const { resolver, calls } = setup({ network: 'bitcoin-mainnet', coin: 'BTC' });

        const out = await resolver.resolveActionParams('LIST', { TYPE: 2, ITEM: [ADDR1] });

        expect(out.ITEM).to.deep.equal([ADDR1]);
        expect(calls.address).to.deep.equal([]);
    });

    it('leaves items untouched when the threshold is above tip plus one', async function () {
        const { resolver, calls } = setup({ lastBlock: -2 });

        const out = await resolver.resolveActionParams('LIST', { TYPE: 2, ITEM: [ADDR1] });

        expect(out.ITEM).to.deep.equal([ADDR1]);
        expect(calls.address).to.deep.equal([]);
    });
});

describe('AddressResolver LIST item types', function () {
    it('never compacts TYPE 1 or TYPE 3 create items', async function () {
        for (const type of [1, 3]) {
            const { resolver, calls } = setup();
            const out = await resolver.resolveActionParams('LIST', { TYPE: type, ITEM: [ADDR1] });
            expect(out.ITEM).to.deep.equal([ADDR1]);
            expect(calls.address).to.deep.equal([]);
        }
    });

    it('compacts a format 1 edit only when its parent reports type 2', async function () {
        const addressParent = setup({ parentType: 2 });
        const tokenParent = setup({ parentType: 1 });
        const edit = { EDIT: 1, LIST_ACTION_INDEX: 41, ITEM: [ADDR1, UNKNOWN] };

        const compacted = await addressParent.resolver.resolveActionParams('LIST', edit);
        const untouched = await tokenParent.resolver.resolveActionParams('LIST', edit);

        expect(compacted.ITEM).to.deep.equal(['^57', UNKNOWN]);
        expect(untouched.ITEM).to.deep.equal([ADDR1, UNKNOWN]);
        expect(addressParent.calls.action).to.deep.equal([41]);
        expect(tokenParent.calls.action).to.deep.equal([41]);
        expect(tokenParent.calls.address).to.deep.equal([]);
    });

    it('keeps edit items when the parent or status read fails', async function () {
        for (const failure of [{ actionError: true }, { statusError: true }]) {
            const { resolver, calls } = setup(Object.assign({ parentType: 2 }, failure));
            const out = await resolver.resolveActionParams('LIST', {
                EDIT: 1, LIST_ACTION_INDEX: 41, ITEM: [ADDR1]
            });
            expect(out.ITEM).to.deep.equal([ADDR1]);
            expect(calls.address).to.deep.equal([]);
        }
    });
});

describe('AddressResolver LIST item safeguards', function () {
    it('fails closed when the activation plane, explorer, or indexed tip is missing', async function () {
        const cases = [
            setup({ network: 'nonsense', coin: 'UNKNOWN' }),
            setup({ coin: 'RBTC', lastBlock: null }),
            setup({ coin: 'UNKNOWN' })
        ];
        cases[2].explorer.getStatus = async () => ({ last_block: { RBTC: 5 } });
        cases.push({
            resolver: new AddressResolver({
                options: {}, config: { network: 'bitcoin-regtest' }, util: new Utility(), explorer: null
            }),
            calls: { address: [] }
        });

        for (const entry of cases) {
            const out = await entry.resolver.resolveActionParams('LIST', { TYPE: 2, ITEM: [ADDR1] });
            expect(out.ITEM).to.deep.equal([ADDR1]);
            expect(entry.calls.address).to.deep.equal([]);
        }
    });

    it('does no LIST reads or compaction when compactAddresses is false', async function () {
        const { resolver, calls } = setup({ options: { compactAddresses: false }, parentType: 2 });
        const params = { EDIT: 1, LIST_ACTION_INDEX: 41, ITEM: [ADDR1] };

        expect(await resolver.resolveActionParams('LIST', params)).to.equal(params);
        expect(calls).to.deep.equal({ status: 0, action: [], address: [] });
    });

    it('runs no more than eight item lookups at once and preserves item order', async function () {
        const { resolver, explorer } = setup({ ids: {} });
        let active = 0;
        let maximum = 0;
        explorer.getAddress = async (address) => {
            active += 1;
            maximum = Math.max(maximum, active);
            await new Promise(resolve => setTimeout(resolve, 2));
            active -= 1;
            return { info: { address_id: Number(address.slice(1)) } };
        };
        const items = Array.from({ length: 20 }, (_, index) => 'a' + (index + 1));

        const out = await resolver.resolveActionParams('LIST', { TYPE: 2, ITEM: items });

        expect(out.ITEM).to.deep.equal(items.map((item) => '^' + item.slice(1)));
        expect(maximum).to.equal(8);
    });
});
