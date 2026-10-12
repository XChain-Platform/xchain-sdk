'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pre-flight activation lookup precedence: '<COIN>:<network>' wins over the bare network row.

const { expect } = require('chai');
const { ACTIVATION_MIRRORS, activationThreshold } = require('../../../../src/preflight/activation.js');

const sdkFor = (network, coin) => ({ config: { network }, explorer: { coin } });

describe('pre-flight activation lookup is coin-first', function () {
    it('every mirrored table pins the bare testnet row to UNARMED beside armed coin rows', function () {
        for (const name of Object.keys(ACTIVATION_MIRRORS)) {
            const t = ACTIVATION_MIRRORS[name].table;
            expect(t.testnet, name).to.equal('UNARMED');
            expect(t['BTC:testnet'], name).to.be.a('number');
        }
    });

    it('resolves the coin row over the network row on testnet', function () {
        for (const name of Object.keys(ACTIVATION_MIRRORS)) {
            const t = ACTIVATION_MIRRORS[name].table;
            expect(activationThreshold(name, sdkFor('bitcoin-testnet', 'TBTC')), name).to.equal(t['BTC:testnet']);
            expect(activationThreshold(name, sdkFor('litecoin-testnet', 'TLTC')), name).to.equal(t['LTC:testnet']);
            expect(activationThreshold(name, sdkFor('dogecoin-testnet', 'TDOGE')), name).to.equal(t['DOGE:testnet']);
        }
    });

    it('resolves the coin from the explorer prefix when the config names only the plane', function () {
        const t = ACTIVATION_MIRRORS.LIST_ADDRESS_REF.table;
        expect(activationThreshold('LIST_ADDRESS_REF', sdkFor('testnet', 'TBTC'))).to.equal(t['BTC:testnet']);
        expect(activationThreshold('LIST_ADDRESS_REF', sdkFor('testnet', 'TDOGE'))).to.equal(t['DOGE:testnet']);
    });

    it('falls back to the bare network row when no coin row exists', function () {
        expect(activationThreshold('LIST_ADDRESS_REF', sdkFor('testnet', null))).to.equal('UNARMED');
        expect(activationThreshold('LIST_ADDRESS_REF', sdkFor('bitcoin-mainnet', 'BTC'))).to.equal('UNARMED');
        expect(activationThreshold('LIST_ADDRESS_REF', sdkFor('bitcoin-regtest', 'RBTC'))).to.equal(0);
    });
});
