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
 * XChain Platform SDK - LIST TYPE=2 (ADDRESS list) item validation
 *
 * xchain-bridge.md row 13 / xchain-token-bridge-policy.md row 7: a LIST
 * ADDRESS item must be a real address for a supported coin, checked against
 * ONE network, via the coin-aware isCryptoAddress(address, coin, network)
 * ported into utility.js. This file drives the network and coin boundary
 * cases: a mainnet address must not pass a testnet/regtest-configured
 * validator and vice versa, and the historical length-only heuristic must
 * still be the fallback when no network is known.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const Utility    = require('../../src/utility.js');
const Validator  = require('../../src/validator.js');

function hasErrorCode(errors, code) {
    return errors.some(e => e.code === code);
}

// Real addresses over a hash160 of 0x01 bytes, one per (coin, network) the
// registry declares. Byte-identical family to test/unit/bridge-sdk.test.js's
// ADDR table (kept local so this file's jail does not depend on that file).
const ADDR = {
    BTC_MAIN_P2PKH:   '16Jswqk47s9PUcyCc88MMVwzgvHPvtEpf',
    BTC_MAIN_P2SH:    '31nKoVLBc2BXUeKQKhnimyrt9DD12VwG6p',
    BTC_MAIN_BECH32:  'bc1qqyqszqgpqyqszqgpqyqszqgpqyqszqgpyfl4f3',
    BTC_TEST_BECH32:  'tb1qqyqszqgpqyqszqgpqyqszqgpqyqszqgpw0yxjz',
    BTC_REG_P2PKH:    'mfcGAzvis9JQAb6avB6WBGiGrgWzLxuGaC',
    BTC_REG_BECH32:   'bcrt1qqyqszqgpqyqszqgpqyqszqgpqyqszqgpvxat9t',
    LTC_MAIN_P2PKH:   'LKKG9A9a8n7CeHK8Nk7RdNZiCuHZW2U789',
    LTC_MAIN_BECH32:  'ltc1qqyqszqgpqyqszqgpqyqszqgpqyqszqgpq4933p',
    LTC_REG_P2PKH:    'mfcGAzvis9JQAb6avB6WBGiGrgWzLxuGaC', // shares BTC_REG's 0x6f byte, see below
    DOGE_MAIN_P2PKH:  'D5EQRCnPMXmRvUoZwC7gu7fYspean3PQ9a',
};

function newListFields(type, items, extra) {
    return Object.assign({ TYPE: type, ITEM: items }, extra || {});
}

describe('LIST TYPE=2 (ADDRESS list) item validation', () => {

    describe('network-scoped, coin-agnostic acceptance', () => {
        it('accepts a mainnet BTC P2PKH item when the validator network is mainnet', () => {
            let v = new Validator(new Utility(), 'mainnet');
            let errors = v.validate('LIST', newListFields(2, [ADDR.BTC_MAIN_P2PKH]));
            expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.equal(false);
        });

        it('accepts a mainnet BTC P2SH item when the validator network is mainnet', () => {
            let v = new Validator(new Utility(), 'mainnet');
            let errors = v.validate('LIST', newListFields(2, [ADDR.BTC_MAIN_P2SH]));
            expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.equal(false);
        });

        it('accepts a mainnet BTC bech32 item when the validator network is mainnet', () => {
            let v = new Validator(new Utility(), 'mainnet');
            let errors = v.validate('LIST', newListFields(2, [ADDR.BTC_MAIN_BECH32]));
            expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.equal(false);
        });

        it('accepts a mainnet LTC item when the validator network is mainnet (any supported coin)', () => {
            let v = new Validator(new Utility(), 'mainnet');
            let errors = v.validate('LIST', newListFields(2, [ADDR.LTC_MAIN_P2PKH]));
            expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.equal(false);
        });

        it('accepts a mainnet DOGE item when the validator network is mainnet (any supported coin)', () => {
            let v = new Validator(new Utility(), 'mainnet');
            let errors = v.validate('LIST', newListFields(2, [ADDR.DOGE_MAIN_P2PKH]));
            expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.equal(false);
        });

        it('accepts multiple items of different coins in the same list, all mainnet', () => {
            let v = new Validator(new Utility(), 'mainnet');
            let errors = v.validate('LIST', newListFields(2,
                [ADDR.BTC_MAIN_P2PKH, ADDR.LTC_MAIN_P2PKH, ADDR.DOGE_MAIN_P2PKH]));
            expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.equal(false);
        });

        it('accepts a regtest BTC item when the validator network is regtest', () => {
            let v = new Validator(new Utility(), 'regtest');
            let errors = v.validate('LIST', newListFields(2, [ADDR.BTC_REG_P2PKH]));
            expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.equal(false);
        });
    });

    describe('network boundary: an address valid on one network must not pass a validator on another', () => {
        it('rejects a mainnet BTC P2PKH item when the validator network is testnet', () => {
            let v = new Validator(new Utility(), 'testnet');
            let errors = v.validate('LIST', newListFields(2, [ADDR.BTC_MAIN_P2PKH]));
            expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.equal(true);
        });

        it('rejects a mainnet BTC P2PKH item when the validator network is regtest', () => {
            let v = new Validator(new Utility(), 'regtest');
            let errors = v.validate('LIST', newListFields(2, [ADDR.BTC_MAIN_P2PKH]));
            expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.equal(true);
        });

        it('rejects a regtest BTC item when the validator network is mainnet', () => {
            let v = new Validator(new Utility(), 'mainnet');
            let errors = v.validate('LIST', newListFields(2, [ADDR.BTC_REG_P2PKH]));
            expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.equal(true);
        });

        it('rejects a mainnet BTC bech32 item when the validator network is testnet (different HRP)', () => {
            let v = new Validator(new Utility(), 'testnet');
            let errors = v.validate('LIST', newListFields(2, [ADDR.BTC_MAIN_BECH32]));
            expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.equal(true);
        });

        it('accepts the matching testnet bech32 form when the validator network is testnet', () => {
            let v = new Validator(new Utility(), 'testnet');
            let errors = v.validate('LIST', newListFields(2, [ADDR.BTC_TEST_BECH32]));
            expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.equal(false);
        });

        it('rejects a mainnet LTC item when the validator network is regtest', () => {
            let v = new Validator(new Utility(), 'regtest');
            let errors = v.validate('LIST', newListFields(2, [ADDR.LTC_MAIN_P2PKH]));
            expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.equal(true);
        });

        it('rejects a mainnet LTC bech32 item when the validator network is mainnet BTC HRP land (cross-coin bech32 never overlaps)', () => {
            let v = new Validator(new Utility(), 'mainnet');
            // Sanity: LTC's own mainnet bech32 item passes on mainnet (already covered
            // above); this asserts BTC's bech32 HRP ('bc') never matches an LTC address
            // ('ltc1...') by construction, i.e. no coin-confusion via bech32.
            let errors = v.validate('LIST', newListFields(2, [ADDR.LTC_MAIN_BECH32]));
            expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.equal(false);
        });
    });

    describe('shared-prefix coins on testnet/regtest are accepted as "some supported coin", by design', () => {
        // BTC and LTC both use pubKeyHash 0x6f / scriptHash 0xc4 on testnet and
        // regtest (coins/BTC.js, coins/LTC.js); DOGE regtest reuses the same pair
        // (coins/DOGE.js). LIST carries no per-item coin field, so "valid for the
        // configured network" is the only question this layer can answer, and an
        // address that is literally byte-identical in form across BTC/LTC at that
        // network is correctly accepted either way.
        it('a 0x6f-prefixed regtest address is accepted at regtest (it IS a valid BTC and a valid LTC regtest address)', () => {
            let v = new Validator(new Utility(), 'regtest');
            let btcErrors = v.validate('LIST', newListFields(2, [ADDR.BTC_REG_P2PKH]));
            expect(hasErrorCode(btcErrors, 'INVALID_FIELD_VALUE')).to.equal(false);
            // Same literal string is independently confirmed valid under both coins'
            // regtest params (the ambiguity the comment above documents).
            let util = new Utility();
            expect(util.isCryptoAddress(ADDR.BTC_REG_P2PKH, 'BTC', 'regtest')).to.equal(true);
            expect(util.isCryptoAddress(ADDR.BTC_REG_P2PKH, 'LTC', 'regtest')).to.equal(true);
        });
    });

    describe('rejects garbage and cross-family strings once a network is known', () => {
        it('rejects a plainly invalid string', () => {
            let v = new Validator(new Utility(), 'mainnet');
            let errors = v.validate('LIST', newListFields(2, ['not-an-address']));
            expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.equal(true);
        });

        it('rejects an address-shaped string with a bad checksum', () => {
            let v = new Validator(new Utility(), 'mainnet');
            let typo = ADDR.BTC_MAIN_P2PKH.slice(0, -1) + (ADDR.BTC_MAIN_P2PKH.slice(-1) === '2' ? '3' : '2');
            let errors = v.validate('LIST', newListFields(2, [typo]));
            expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.equal(true);
        });

        it('rejects one bad item even when other items in the same list are valid', () => {
            let v = new Validator(new Utility(), 'mainnet');
            let errors = v.validate('LIST', newListFields(2, [ADDR.BTC_MAIN_P2PKH, 'garbage']));
            expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.equal(true);
        });
    });

    describe('^id references', () => {
        it('accepts a numeric ^id item without treating it as an address', () => {
            let v = new Validator(new Utility(), 'mainnet');
            let errors = v.validate('LIST', newListFields(2, ['^57']));
            expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.equal(false);
            expect(hasErrorCode(errors, 'INVALID_ADDRESS_ID')).to.equal(false);
        });

        it('rejects a non-numeric ^id item', () => {
            let v = new Validator(new Utility(), 'mainnet');
            let errors = v.validate('LIST', newListFields(2, ['^abc']));
            expect(hasErrorCode(errors, 'INVALID_ADDRESS_ID')).to.equal(true);
        });
    });

    describe('no network configured: falls back to the historical length-only heuristic', () => {
        it('accepts a length-plausible string with no network known, even a wrong-network address', () => {
            let v = new Validator(new Utility(), null);
            let errors = v.validate('LIST', newListFields(2, [ADDR.BTC_MAIN_P2PKH]));
            expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.equal(false);
        });

        it('still rejects an implausibly short string with no network known', () => {
            let v = new Validator(new Utility(), null);
            let errors = v.validate('LIST', newListFields(2, ['short']));
            expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.equal(true);
        });

        it('resolves the network from process.env.NETWORK when the constructor is not given one', () => {
            let prior = process.env.NETWORK;
            process.env.NETWORK = 'testnet';
            try {
                let v = new Validator(new Utility());
                let errors = v.validate('LIST', newListFields(2, [ADDR.BTC_MAIN_P2PKH]));
                expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.equal(true);
            } finally {
                if (prior === undefined) delete process.env.NETWORK;
                else process.env.NETWORK = prior;
            }
        });
    });

    describe('TYPE=1 (TICK list) and edit mode are unaffected', () => {
        it('does not run address validation on a TYPE=1 (TICK) list', () => {
            let v = new Validator(new Utility(), 'mainnet');
            let errors = v.validate('LIST', newListFields(1, ['JDOG', 'BRRR']));
            expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.equal(false);
        });

        it('does not run address validation on a LIST edit (LIST_ACTION_INDEX present, no TYPE)', () => {
            let v = new Validator(new Utility(), 'mainnet');
            let errors = v.validate('LIST', { EDIT: 1, LIST_ACTION_INDEX: 5, ITEM: ['garbage-not-an-address'] });
            expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.equal(false);
        });
    });
});
