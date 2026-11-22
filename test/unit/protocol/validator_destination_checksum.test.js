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
 **********************************************************************
 *
 * XChain Platform SDK - full-address field checksum validation
 *
 * DESTINATION, GET_ADDRESS, TRANSFER and TRANSFER_SUPPLY used the
 * one-argument isCryptoAddress length heuristic even when the validator knew
 * its network, so a case-flipped (checksum-invalid) base58 address passed
 * pre-validation, was built into the action string and only failed on chain
 * after the fee was paid. With a known network these fields now get the same
 * network-aware base58check / bech32 check LIST address items use; with no
 * network the length heuristic stays the fallback.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const Utility    = require('../../../src/utils/utility.js');
const Validator  = require('../../../src/protocol/validator.js');
const XChainSDK  = require('../../../src/XChainSDK.js');

// Checksum-valid regtest addresses (hash160 of 0x01 bytes, same family as the
// LIST address tests) and single-letter case flips that break the checksum.
const REG_P2PKH      = 'mfcGAzvis9JQAb6avB6WBGiGrgWzLxuGaC';
const REG_BECH32     = 'bcrt1qqyqszqgpqyqszqgpqyqszqgpqyqszqgpvxat9t';
const FLIPPED_REPRO  = 'n2f3Z3u6jun5MMRWPTEurjQi5LnvVauMAb';
const FLIPPED_P2PKH  = 'mfcGAzvis9JQAb6avB6WBGiGrgWzLxuGac';
const BAD_BECH32     = 'bcrt1qqyqszqgpqyqszqgpqyqszqgpqyqszqgpvxat9q';
const MAIN_P2PKH     = '16Jswqk47s9PUcyCc88MMVwzgvHPvtEpf';

function fieldErrors(errors, field) {
    return errors.filter(e => e.code === 'INVALID_FIELD_VALUE' && e.details && e.details.field === field);
}

// Run the address check for one field through the full validator so the
// field-rule dispatch, not a helper, decides the verdict.
function verdict(validator, field, value) {
    let errors = validator.validate('MINT', { TICK: 'XCHAIN', AMOUNT: 1, DESTINATION: REG_P2PKH, [field]: value });
    return fieldErrors(errors, field).length === 0;
}

const ADDRESS_FIELDS = ['DESTINATION', 'GET_ADDRESS', 'TRANSFER', 'TRANSFER_SUPPLY'];

function sdkReproSuite() {
    describe('SDK validateAction (repro)', () => {
        let sdk;
        before(() => {
            sdk = new XChainSDK({ network: 'bitcoin-regtest', explorerUrl: '127.0.0.1', explorerPort: 18080, compactAddresses: false });
        });

        it('refuses a case-flipped base58 DESTINATION on bitcoin-regtest', () => {
            let res = sdk.validateAction('MINT', { tick: 'XCHAIN', amount: 1, destination: FLIPPED_REPRO });
            expect(res.valid).to.equal(false);
            expect(fieldErrors(res.errors, 'DESTINATION')).to.have.length(1);
        });

        it('accepts a checksum-valid regtest DESTINATION', () => {
            let res = sdk.validateAction('MINT', { tick: 'XCHAIN', amount: 1, destination: REG_P2PKH });
            expect(fieldErrors(res.errors, 'DESTINATION')).to.have.length(0);
        });

        it('accepts a ^id address reference DESTINATION', () => {
            let res = sdk.validateAction('MINT', { tick: 'XCHAIN', amount: 1, destination: '^1' });
            expect(fieldErrors(res.errors, 'DESTINATION')).to.have.length(0);
            expect(res.errors.some(e => e.code === 'INVALID_ADDRESS_ID')).to.equal(false);
        });
    });
}

function networkSuites() {
    for (let network of ['bitcoin-regtest', 'regtest']) {
        describe('validator with network ' + network, () => {
            let v;
            before(() => { v = new Validator(new Utility(), network); });

            for (let field of ADDRESS_FIELDS) {
                it(field + ' refuses checksum-invalid base58 and bech32 values', () => {
                    expect(verdict(v, field, FLIPPED_REPRO)).to.equal(false);
                    expect(verdict(v, field, FLIPPED_P2PKH)).to.equal(false);
                    expect(verdict(v, field, BAD_BECH32)).to.equal(false);
                });

                it(field + ' refuses a mainnet address on a regtest validator', () => {
                    expect(verdict(v, field, MAIN_P2PKH)).to.equal(false);
                });

                it(field + ' accepts checksum-valid regtest base58 and bech32 values and ^id refs', () => {
                    expect(verdict(v, field, REG_P2PKH)).to.equal(true);
                    expect(verdict(v, field, REG_BECH32)).to.equal(true);
                    expect(verdict(v, field, '^1')).to.equal(true);
                });
            }
        });
    }
}

function noNetworkSuite() {
    describe('validator with no network', () => {
        let v, saved;
        before(() => {
            saved = process.env.NETWORK;
            delete process.env.NETWORK;
            v = new Validator(new Utility());
        });
        after(() => {
            if (saved === undefined) delete process.env.NETWORK;
            else process.env.NETWORK = saved;
        });

        it('keeps the length heuristic fallback', () => {
            expect(v.network).to.equal(null);
            for (let field of ADDRESS_FIELDS) {
                expect(verdict(v, field, FLIPPED_REPRO)).to.equal(true);
                expect(verdict(v, field, 'tooshort')).to.equal(false);
            }
        });
    });
}

describe('full-address fields use the network-aware checksum check', () => {
    sdkReproSuite();
    networkSuites();
    noNetworkSuite();
});
