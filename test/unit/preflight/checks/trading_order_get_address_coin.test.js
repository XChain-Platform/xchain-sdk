'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A cross-chain ORDER's GET_ADDRESS is judged against GET_COIN once ORDER_GET_ADDRESS_COIN
// is active (xchain-indexer src/actions/order/validate.js validateFormats).

const { expect } = require('chai');
const { mockSdk } = require('../helpers/mock.js');
const { activeByWallClock, DISCLOSURE_MIRRORS } = require('../../../../src/preflight/activation.js');

// P2WPKH addresses over the 20-byte program 0x07 repeated, one per HRP.
const ADDR = Object.freeze({
    rltc: 'rltc1qqurswpc8qurswpc8qurswpc8qurswpc8ntpxlg',
    bcrt: 'bcrt1qqurswpc8qurswpc8qurswpc8qurswpc8dxm0gk',
    bc: 'bc1qqurswpc8qurswpc8qurswpc8qurswpc89fe3yv',
    ltc: 'ltc1qqurswpc8qurswpc8qurswpc8qurswpc8p4r4uu',
});

function wire(getCoin, getAddress) {
    return `ORDER|0|BTC|ALPHA|1|0|${getCoin}||1|0|${getAddress}||||m`;
}

async function report(getCoin, getAddress, opts = {}) {
    const sdk = mockSdk({
        network: opts.network || 'bitcoin-regtest',
        explorerSpec: {
            getFeeQuote: () => ({ feeExempt: true }),
            getToken: () => ({ info: { tick: 'ALPHA', tick_id: 7, decimals: 0 } }),
            getBalances: () => [{ tick: 'ALPHA', amount: '10' }],
        },
    });
    if (opts.coin !== null) sdk.explorer.coin = opts.coin || 'RBTC';
    return sdk.preflight(wire(getCoin, getAddress), { source: 'me', preflight: 'report', bypassCache: true });
}

const getCoinErrors = (result) => result.findings.filter((f) =>
    f.code === 'VALIDATOR_SEMANTICS' && f.severity === 'error' && f.message.includes('pays out on GET_COIN'));
const getCoinDisclosures = (result) => result.unverified.filter((u) =>
    u.check === 'VALIDATOR_SEMANTICS' && u.reason.includes('GET_ADDRESS'));

describe('pre-flight ORDER cross-chain GET_ADDRESS against GET_COIN', function () {
    it('pins the gate as unarmed on mainnet, armed on testnet and active from genesis on regtest', function () {
        expect(DISCLOSURE_MIRRORS.ORDER_GET_ADDRESS_COIN.table)
            .to.deep.equal({ mainnet: 'UNARMED', testnet: 1794873600, regtest: 0 });
    });

    it('reads the testnet gate by the wall clock on either side of its instant', function () {
        const sdk = { config: { network: 'bitcoin-testnet' } };
        expect(activeByWallClock('ORDER_GET_ADDRESS_COIN', sdk, 1794873599 * 1000)).to.equal(false);
        expect(activeByWallClock('ORDER_GET_ADDRESS_COIN', sdk, 1794873600 * 1000)).to.equal(true);
        expect(activeByWallClock('ORDER_GET_ADDRESS_COIN', { config: { network: 'bitcoin-mainnet' } })).to.equal(false);
    });

    it('accepts a GET_ADDRESS that is a valid GET_COIN address', async function () {
        const result = await report('LTC', ADDR.rltc);
        expect(getCoinErrors(result)).to.deep.equal([]);
        expect(getCoinDisclosures(result)).to.deep.equal([]);
    });

    it('refuses a GET_ADDRESS of the local chain on a cross-chain ORDER while the gate is active', async function () {
        const result = await report('LTC', ADDR.bcrt);
        const found = getCoinErrors(result);
        expect(found).to.have.length(1);
        expect(found[0].overridable).to.equal(false);
        expect(found[0].message).to.contain('not a LTC regtest address');
        expect(found[0].message).to.contain('invalid: GET_ADDRESS (format)');
    });

    it('refuses a bech32 GET_ADDRESS for a GET_COIN with no segwit', async function () {
        const result = await report('DOGE', ADDR.bcrt);
        expect(getCoinErrors(result)).to.have.length(1);
    });

    it('leaves a same-chain ORDER to the existing rules', async function () {
        const result = await report('BTC', ADDR.rltc);
        expect(getCoinErrors(result)).to.deep.equal([]);
    });

    it('skips an address reference and a contract address', async function () {
        expect(getCoinErrors(await report('LTC', '^57'))).to.deep.equal([]);
        expect(getCoinErrors(await report('LTC', 'C:BTC:5'))).to.deep.equal([]);
    });

    it('adds nothing on a network where the gate is unarmed', async function () {
        const result = await report('LTC', ADDR.bc, { network: 'bitcoin-mainnet', coin: 'BTC' });
        expect(getCoinErrors(result)).to.deep.equal([]);
        expect(getCoinDisclosures(result)).to.deep.equal([]);
        // The address the gate would accept there is untouched too.
        expect(getCoinErrors(await report('LTC', ADDR.ltc, { network: 'bitcoin-mainnet', coin: 'BTC' })))
            .to.deep.equal([]);
    });

    it('discloses the check when no chain coin is configured', async function () {
        const result = await report('LTC', ADDR.bcrt, { coin: null });
        expect(getCoinErrors(result)).to.deep.equal([]);
        expect(getCoinDisclosures(result)).to.have.length(1);
    });
});
