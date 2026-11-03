'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const { mockSdk, notFound } = require('../helpers/mock.js');
const Formats = require('../../../../src/protocol/formats.js');
const numeric = require('../../../../src/preflight/numeric.js');
const { PREFIXED_INTEGER_FIELDS, FIELD_MAX } = require('../../../../src/preflight/universal/prefixed_integers.js');

// A hexadecimal, binary or octal integer field passes the indexer's integer and range rules,
// but its row writer binds the wire text into an integer column, which a strict session
// refuses, so the block halted. The indexer now refuses each one from genesis as
// '<FIELD> (format)' (util.keepsPrefixedSpelling in xchain-indexer value_checks.js).
const U64_MAX = '18446744073709551615';
const PREFIXED = ['0x10', '0X10', '0b101', '0B101', '0o17', '0O17'];
const DECIMAL = ['16', '1e12', '+100', '00100'];
const DEFAULTS = {
    GIVE_TICK: 'JDOG', GIVE_AMOUNT: '1', GET_COIN: 'RBTC', GET_AMOUNT: '1', LABEL: 'Rain', OUTCOMES: 'yes,no',
    TICK: 'JDOG', DEADLINE: '4102444800', REFUND_WINDOW: '86400', MAX_SUPPLY: '1000', MAX_MINT: '10',
    DECIMALS: '0', DISPENSER_ACTION_INDEX: '5', ORDER_ACTION_INDEX: '5', SWAP_ACTION_INDEX: '5',
    FEED_ACTION_INDEX: '7', OUTCOME: '1', AMOUNT: '1', COIN1: 'BTC', COIN2: 'DOGE', COIN1_ACTION_INDEX: '0',
    COIN2_ACTION_INDEX: '5',
};

function wireFor(action, version, over) {
    const names = Formats[action][version].split('|').slice(1);
    const values = names.map((name) => (name in over ? over[name] : DEFAULTS[name] || ''));
    return [action, version].concat(values).join('|');
}

async function reportFor(wire, network = 'bitcoin-regtest', coin = 'RBTC') {
    const sdk = mockSdk({ network, explorerSpec: { getFeeQuote: () => ({ feeExempt: true }), getToken: notFound,
        getAction: notFound } });
    sdk.explorer.coin = coin;
    return sdk.preflight(wire, { source: 'me', preflight: 'report' });
}
const prefixedFindings = (r, field) => r.findings.filter((f) => f.code === 'VALIDATOR_SEMANTICS'
    && f.severity === 'error' && f.data && f.data.field === field && f.data.verdict === `invalid: ${field} (format)`);

async function expectRefused(wire, action, field, value) {
    const found = prefixedFindings(await reportFor(wire), field);
    expect(found, `${wire}`).to.have.length(1);
    expect(found[0].overridable).to.equal(false);
    expect(found[0].message).to.include(`the indexer refuses this ${action} as invalid: ${field} (format)`);
    expect(found[0].data).to.include({ value, max: FIELD_MAX[field], haltClass: true });
}
async function expectClear(wire, field) {
    expect(prefixedFindings(await reportFor(wire), field), wire).to.deep.equal([]);
}

const CASES = [];
for (const [action, versions] of Object.entries(PREFIXED_INTEGER_FIELDS))
    for (const [version, fields] of Object.entries(versions))
        for (const field of fields) CASES.push([action, version, field]);

function registerPredicate() {
    it('pins the fields and column bounds the indexer refuses prefixed literals in', function () {
        expect(CASES.map((c) => c.join(' '))).to.deep.equal(['DISPENSER 0 EXPIRATION', 'DISPENSER 2 EXPIRATION',
            'ORDER 0 EXPIRATION', 'ORDER 2 EXPIRATION', 'SWAP 0 EXPIRATION', 'SWAP 2 EXPIRATION', 'BET 0 DEADLINE',
            'BET 0 REFUND_WINDOW', 'BET 2 OUTCOME', 'BET 3 OUTCOME', 'ISSUE 0 CALLBACK_BLOCK', 'ISSUE 0 MINT_START_BLOCK',
            'ISSUE 0 MINT_STOP_BLOCK', 'ISSUE 2 MINT_START_BLOCK', 'ISSUE 2 MINT_STOP_BLOCK', 'ISSUE 4 CALLBACK_BLOCK', 'LINK 0 COIN1_ACTION_INDEX',
            'LINK 0 COIN2_ACTION_INDEX']);
        expect(FIELD_MAX).to.deep.equal({ EXPIRATION: U64_MAX, DEADLINE: U64_MAX, REFUND_WINDOW: U64_MAX,
            CALLBACK_BLOCK: U64_MAX, MINT_START_BLOCK: U64_MAX, MINT_STOP_BLOCK: U64_MAX, OUTCOME: '4294967295',
            COIN1_ACTION_INDEX: U64_MAX, COIN2_ACTION_INDEX: U64_MAX });
    });

    it('keepsPrefixedSpelling answers true only for an unsigned radix literal inside the column', function () {
        for (const value of PREFIXED.concat([' 0x10 ', '0xffffffffffffffff', '0x0']))
            expect(numeric.keepsPrefixedSpelling(value, U64_MAX), value).to.equal(true);
        for (const value of DECIMAL.concat(['-0x10', '+0x10', '0x', '0b2', '0o8', '0x10000000000000000', '', null]))
            expect(numeric.keepsPrefixedSpelling(value, U64_MAX), String(value)).to.equal(false);
        expect(numeric.keepsPrefixedSpelling('0xffffffff', '4294967295')).to.equal(true);
        expect(numeric.keepsPrefixedSpelling('0x100000000', '4294967295')).to.equal(false);
    });
}

function registerMirroredRefusals() {
    for (const [action, version, field] of CASES) {
        it(`refuses ${action} ${version} ${field} written as a hexadecimal, binary or octal literal`, async function () {
            for (const value of PREFIXED)
                await expectRefused(wireFor(action, version, { [field]: value }), action, field, value);
        });

        it(`keeps the verdict of a decimal ${action} ${version} ${field} spelling`, async function () {
            for (const value of DECIMAL) await expectClear(wireFor(action, version, { [field]: value }), field);
        });
    }
}

function registerBoundaries() {
    it('leaves a literal past the column range to normalization, which stores it as NULL', async function () {
        await expectRefused(wireFor('ORDER', '0', { EXPIRATION: '0xffffffffffffffff' }), 'ORDER', 'EXPIRATION',
            '0xffffffffffffffff');
        await expectClear(wireFor('ORDER', '0', { EXPIRATION: '0x10000000000000000' }), 'EXPIRATION');
        await expectRefused(wireFor('BET', '3', { OUTCOME: '0xffffffff' }), 'BET', 'OUTCOME', '0xffffffff');
        await expectClear(wireFor('BET', '3', { OUTCOME: '0x100000000' }), 'OUTCOME');
    });

    it('keeps an ISSUE CALLBACK_BLOCK literal reading zero, which the tokens row binds as 0', async function () {
        await expectClear(wireFor('ISSUE', '4', { TICK: 'JDOGX', CALLBACK_BLOCK: '0x0' }), 'CALLBACK_BLOCK');
        await expectClear(wireFor('ISSUE', '0', { TICK: 'JDOGX', CALLBACK_BLOCK: '0b0' }), 'CALLBACK_BLOCK');
        await expectRefused(wireFor('ISSUE', '0', { TICK: 'JDOGX', CALLBACK_BLOCK: '0b1' }), 'ISSUE',
            'CALLBACK_BLOCK', '0b1');
    });

    it('refuses nothing in a field or format the indexer does not judge this way', async function () {
        await expectClear(wireFor('ISSUE', '2', { TICK: 'JDOGX', MAX_MINT: '0x10' }), 'MAX_MINT');
        await expectClear(wireFor('BET', '0', { MIN_AMOUNT: '0x10' }), 'MIN_AMOUNT');
    });

    it('judges a BATCH sub-command the same way', async function () {
        const order = wireFor('ORDER', '2', { EXPIRATION: '0x10' }).replace(/\|+$/, '');
        await expectRefused(`BATCH|0|${order}`, 'ORDER', 'EXPIRATION', '0x10');
    });
}

// The indexer refuses a prefixed mint window last on a valid ISSUE where the
// amount-representability rule is unarmed (mainnet), and with the same verdict through
// that rule where it is armed (regtest), so pre-flight refuses it on both planes.
const fieldFindings = (r, code, field) => r.findings.filter((f) => f.code === code && f.severity === 'error'
    && f.data && f.data.field === field);

function registerMintWindow() {
    it('refuses a mint window literal reading zero, which the tokens row binds as carried', async function () {
        for (const field of ['MINT_START_BLOCK', 'MINT_STOP_BLOCK']) {
            await expectRefused(wireFor('ISSUE', '2', { TICK: 'JDOGX', [field]: '0x0' }), 'ISSUE', field, '0x0');
            await expectClear(wireFor('ISSUE', '2', { TICK: 'JDOGX', [field]: '0x10000000000000000' }), field);
        }
    });

    it('refuses it on mainnet, where the amount-representability rule does not', async function () {
        for (const field of ['MINT_START_BLOCK', 'MINT_STOP_BLOCK']) {
            const r = await reportFor(wireFor('ISSUE', '2', { TICK: 'JDOGX', [field]: '0x7fffffff' }),
                'bitcoin-mainnet', 'BTC');
            expect(prefixedFindings(r, field), field).to.have.length(1);
            expect(fieldFindings(r, 'AMOUNT_FORMAT_INVALID', field), field).to.deep.equal([]);
            expect(prefixedFindings(await reportFor(wireFor('ISSUE', '2', { TICK: 'JDOGX', [field]: '1000' }),
                'bitcoin-mainnet', 'BTC'), field)).to.deep.equal([]);
        }
        const batch = wireFor('ISSUE', '2', { TICK: 'JDOGX', MINT_STOP_BLOCK: '0o7777' }).replace(/\|+$/, '');
        expect(prefixedFindings(await reportFor(`BATCH|0|${batch}`, 'bitcoin-mainnet', 'BTC'), 'MINT_STOP_BLOCK'))
            .to.have.length(1);
    });

    it('agrees with the amount-format verdict where the representability rule is armed', async function () {
        const r = await reportFor(wireFor('ISSUE', '2', { TICK: 'JDOGX', MAX_MINT: '',
            MINT_START_BLOCK: '0b1111111111' }));
        expect(prefixedFindings(r, 'MINT_START_BLOCK')).to.have.length(1);
        const amount = fieldFindings(r, 'AMOUNT_FORMAT_INVALID', 'MINT_START_BLOCK');
        expect(amount).to.have.length(1);
        expect(amount[0].message).to.include('invalid: MINT_START_BLOCK (format)');
    });
}

function registerLink() {
    it('refuses a LINK action index literal on both regtest coins, as the indexer does', async function () {
        for (const [network, coin] of [['bitcoin-regtest', 'RBTC'], ['dogecoin-regtest', 'RDOGE']])
            for (const field of ['COIN1_ACTION_INDEX', 'COIN2_ACTION_INDEX'])
                for (const value of ['0x10', '0b101', '0o17']) {
                    const r = await reportFor(wireFor('LINK', '0', { [field]: value }), network, coin);
                    const found = prefixedFindings(r, field);
                    expect(found, `${network} ${field} ${value}`).to.have.length(1);
                    expect(found[0].data).to.include({ value, haltClass: true, verdict: `invalid: ${field} (format)` });
                    expect(found[0].overridable).to.equal(false);
                }
    });

    it('leaves a decimal or past-range LINK action index alone', async function () {
        for (const field of ['COIN1_ACTION_INDEX', 'COIN2_ACTION_INDEX']) {
            await expectClear(wireFor('LINK', '0', { [field]: '16' }), field);
            await expectClear(wireFor('LINK', '0', { [field]: '0x10000000000000000' }), field);
        }
    });

    it('judges a LINK inside a BATCH the same way', async function () {
        const link = wireFor('LINK', '0', { COIN1_ACTION_INDEX: '0x10' }).replace(/\|+$/, '');
        await expectRefused(`BATCH|0|${link}`, 'LINK', 'COIN1_ACTION_INDEX', '0x10');
    });
}

describe('pre-flight universal: hexadecimal, binary and octal integer wire fields', function () {
    registerPredicate();
    registerMirroredRefusals();
    registerBoundaries();
    registerMintWindow();
    registerLink();
});
