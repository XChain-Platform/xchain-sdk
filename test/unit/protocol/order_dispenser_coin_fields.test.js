// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

// The indexer refuses an ORDER, SWAP or DISPENSER create whose GIVE_COIN or
// GET_COIN is empty, and reads a TICK holding the coin's own name as an unknown
// token. These pin the strings the SDK builds to the shape the chain accepts.

const { expect } = require('chai');
const config  = require('../../../src/config.js');
const Utility = require('../../../src/utils/utility.js');
const Actions = require('../../../src/actions/index.js');

function actionsOn(network) {
    return new Actions({ config: config.getConfig(), util: new Utility(), options: { network } });
}

function build(actions, action, params) {
    return actions.createAction({ action, params });
}

describe('market creates fill GIVE_COIN and GET_COIN', function () {
    const doge = actionsOn('dogecoin-testnet');

    it('moves the native coin out of the TICK slot and fills both COIN fields', function () {
        let r = build(doge, 'ORDER', { give_tick: 'DOGE', give_amount: '1000000000', get_tick: '^2', get_amount: '10000' });
        expect(r.actionString).to.equal('ORDER|0|DOGE||1000000000||DOGE|^2|10000');
    });

    it('builds the same string as explicit COIN fields with an empty native tick', function () {
        let r = build(doge, 'ORDER', { give_coin: 'DOGE', give_amount: '1000000000', get_coin: 'DOGE', get_tick: '^2', get_amount: '10000' });
        expect(r.actionString).to.equal('ORDER|0|DOGE||1000000000||DOGE|^2|10000');
    });

    it('fills both COIN fields on a token for token order', function () {
        let r = build(doge, 'ORDER', { give_tick: '^2', give_amount: '1', get_tick: '^3', get_amount: '1' });
        expect(r.actionString).to.equal('ORDER|0|DOGE|^2|1||DOGE|^3|1');
    });

    it('clears a native tick that repeats the COIN field', function () {
        let r = build(doge, 'ORDER', { give_coin: 'DOGE', give_tick: 'DOGE', give_amount: '1000000000', get_coin: 'DOGE', get_tick: '^2', get_amount: '10000' });
        expect(r.actionString).to.equal('ORDER|0|DOGE||1000000000||DOGE|^2|10000');
    });

    it('writes a lowercase coin in the case the indexer compares', function () {
        let r = build(doge, 'ORDER', { give_coin: 'doge', give_amount: '1000000000', get_coin: 'doge', get_tick: '^2', get_amount: '10000' });
        expect(r.fields.GIVE_COIN).to.equal('DOGE');
        expect(r.fields.GET_COIN).to.equal('DOGE');
    });

    it('keeps an explicit cross-chain GET_COIN', function () {
        let r = build(doge, 'ORDER', { give_tick: '^2', give_amount: '1', get_coin: 'BTC', get_tick: 'FOO', get_amount: '1', get_address: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh' });
        expect(r.fields.GIVE_COIN).to.equal('DOGE');
        expect(r.fields.GET_COIN).to.equal('BTC');
        expect(r.fields.GET_TICK).to.equal('FOO');
    });

    it('leaves another coin name in a TICK slot, since it may be a bridged root token', function () {
        let r = build(doge, 'ORDER', { give_tick: '^2', give_amount: '1', get_tick: 'BTC', get_amount: '1' });
        expect(r.fields.GET_TICK).to.equal('BTC');
        expect(r.fields.GET_COIN).to.equal('DOGE');
    });

    it('leaves an order cancel untouched', function () {
        let r = build(doge, 'ORDER', { order_action_index: 4951 });
        expect(r.actionString).to.equal('ORDER|1|4951');
    });
});

describe('swap and dispenser creates fill GIVE_COIN and GET_COIN', function () {
    const doge = actionsOn('dogecoin-testnet');

    it('fills a SWAP create the same way', function () {
        let r = build(doge, 'SWAP', { give_tick: '^2', give_amount: '1', get_tick: '^3', get_amount: '1' });
        expect(r.fields.GIVE_COIN).to.equal('DOGE');
        expect(r.fields.GET_COIN).to.equal('DOGE');
    });

    it('fills a token-paid DISPENSER create', function () {
        let r = build(doge, 'DISPENSER', { give_tick: '^2', give_amount: '1', give_escrow: '10', get_tick: '^3', get_amount: '1' });
        expect(r.fields.GIVE_COIN).to.equal('DOGE');
        expect(r.fields.GET_COIN).to.equal('DOGE');
        expect(r.fields.GET_TICK).to.equal('^3');
    });

    it('reads a native coin GET_TICK on a DISPENSER as coin-paid', function () {
        let r = build(doge, 'DISPENSER', { give_tick: '^2', give_amount: '1', give_escrow: '10', get_tick: 'DOGE', get_amount: '100000000' });
        expect(r.fields.GET_COIN).to.equal('DOGE');
        expect(r.fields).to.not.have.property('GET_TICK');
    });

    it('validateAction agrees with createAction on the filled fields', function () {
        let v = doge.validateAction('ORDER', { give_tick: 'DOGE', give_amount: '1000000000', get_tick: '^2', get_amount: '10000' });
        expect(v.valid).to.equal(true);
    });
});

describe('market creates with no network to default from', function () {
    const bare = actionsOn(null);

    it('clears a TICK that names its own side\'s COIN', function () {
        let r = build(bare, 'ORDER', { give_coin: 'BTC', give_tick: '^2', give_amount: '1', get_coin: 'btc', get_tick: 'BTC', get_amount: '1' });
        expect(r.fields.GET_COIN).to.equal('BTC');
        expect(r.fields).to.not.have.property('GET_TICK');
        expect(r.actionString).to.equal('ORDER|0|BTC|^2|1||BTC||1');
    });

    it('reads a cross-chain TICK naming the GET_COIN as that chain\'s native coin', function () {
        let r = build(actionsOn('dogecoin-testnet'), 'ORDER', { give_tick: '^2', give_amount: '1', get_coin: 'BTC', get_tick: 'BTC', get_amount: '1', get_address: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh' });
        expect(r.fields.GIVE_COIN).to.equal('DOGE');
        expect(r.fields.GET_COIN).to.equal('BTC');
        expect(r.fields).to.not.have.property('GET_TICK');
    });

    it('validateAction refuses empty COIN fields instead of passing them', function () {
        bare.network = null;
        let v = bare.validateAction('ORDER', { give_tick: '^2', give_amount: '1', get_tick: '^3', get_amount: '1' });
        expect(v.valid).to.equal(false);
        let fields = v.errors.map(e => e.details && e.details.field);
        expect(fields).to.include('GIVE_COIN');
        expect(fields).to.include('GET_COIN');
    });

    it('the validator refuses a DISPENSER create with an empty GIVE_COIN or GET_COIN', function () {
        let errors = bare.validator.validate('DISPENSER', { GIVE_TICK: 'JDOG', GIVE_AMOUNT: '1', GIVE_ESCROW: '10', GET_TICK: 'XCP', GET_AMOUNT: '0.5' });
        let missing = errors.filter(e => e.code === 'MISSING_REQUIRED_FIELD').map(e => e.details.field);
        expect(missing).to.include.members(['GIVE_COIN', 'GET_COIN']);
    });

    it('createAction throws rather than build a string the chain must reject', function () {
        bare.network = null;
        expect(() => build(bare, 'DISPENSER', { give_tick: '^2', give_amount: '1', give_escrow: '10', get_tick: '^3', get_amount: '1' })).to.throw(/GIVE_COIN/);
    });
});
