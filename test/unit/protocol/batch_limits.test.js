'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The per-leg AIRDROP weight of a BATCH sub-command, at, below and without the
// BATCH_AIRDROP_LEG_WEIGHT gate.

const { expect } = require('chai');
const { subCommandWeight, batchWeight, BATCH_COMMAND_WEIGHTS } = require('../../../src/protocol/batch_limits.js');
const { BATCH_AIRDROP_LEG_WEIGHT_ACTIVATION, airdropLegCount }
    = require('../../../src/protocol/batch_limits/airdrop_legs.js');
const { UNARMED } = require('../../../src/consensus/gate_registry/core.js');

const wire = (...parts) => parts.join('|');
const REGTEST = Object.freeze({ network: 'regtest', height: 200 });
const TESTNET = Object.freeze({ network: 'testnet', height: 200 });
const MAINNET = Object.freeze({ network: 'mainnet', height: 200 });

const ONE_LEG = wire('AIRDROP', '0', 'JDOG', '1', '5');
const TWO_LEG_BRIEF = wire('AIRDROP', '1', '5', 'JDOG', '1', 'XCP', '2');
const THREE_LEG_FULL = wire('AIRDROP', '2', 'JDOG', '1', '5', 'XCP', '2', '6', 'SAT', '3', '7');

describe('batch_limits: AIRDROP weighs per leg at the BATCH_AIRDROP_LEG_WEIGHT gate', function () {
    let savedNetwork;
    beforeEach(function () { savedNetwork = process.env.NETWORK; delete process.env.NETWORK; });
    afterEach(function () {
        if (savedNetwork === undefined) delete process.env.NETWORK;
        else process.env.NETWORK = savedNetwork;
    });

    it('mirrors the gate row: unarmed on mainnet and testnet, genesis on regtest', function () {
        expect(BATCH_AIRDROP_LEG_WEIGHT_ACTIVATION).to.deep.equal({ mainnet: UNARMED, testnet: UNARMED, regtest: 0 });
        expect(BATCH_COMMAND_WEIGHTS.AIRDROP).to.equal(25);
    });

    it('weighs a one-leg AIRDROP as 25 above the gate', function () {
        expect(subCommandWeight(ONE_LEG, REGTEST)).to.equal(25);
        expect(subCommandWeight(wire('AIRDROP', '1', '5', 'JDOG', '1'), REGTEST)).to.equal(25);
    });

    it('weighs a multi-leg AIRDROP as 25 per leg above the gate, in every multi-leg format', function () {
        expect(subCommandWeight(TWO_LEG_BRIEF, REGTEST)).to.equal(50);
        expect(subCommandWeight(wire('AIRDROP', '1', '5', 'JDOG', '1', 'XCP', '2', 'memo'), REGTEST)).to.equal(50);
        expect(subCommandWeight(THREE_LEG_FULL, REGTEST)).to.equal(75);
        expect(subCommandWeight(THREE_LEG_FULL + '|memo', REGTEST)).to.equal(75);
        expect(subCommandWeight(wire('AIRDROP', '3', 'JDOG', '1', '5', 'm1', 'XCP', '2', '6', 'm2'), REGTEST)).to.equal(50);
    });

    it('weighs the DROP alias as the AIRDROP it is', function () {
        expect(subCommandWeight(wire('DROP', '1', '5', 'JDOG', '1', 'XCP', '2'), REGTEST)).to.equal(50);
    });

    it('keeps a multi-leg AIRDROP flat at 25 below the gate, on testnet and mainnet', function () {
        expect(subCommandWeight(TWO_LEG_BRIEF, TESTNET)).to.equal(25);
        expect(subCommandWeight(THREE_LEG_FULL, MAINNET)).to.equal(25);
        expect(batchWeight([TWO_LEG_BRIEF, THREE_LEG_FULL], TESTNET)).to.equal(50);
    });

    it('keeps a multi-leg AIRDROP flat when neither the call nor NETWORK names a network', function () {
        expect(subCommandWeight(TWO_LEG_BRIEF)).to.equal(25);
        expect(batchWeight([TWO_LEG_BRIEF])).to.equal(25);
    });

    it('reads a <coin>-<network> NETWORK setting when the call names no network', function () {
        process.env.NETWORK = 'bitcoin-regtest';
        expect(subCommandWeight(TWO_LEG_BRIEF)).to.equal(50);
        process.env.NETWORK = 'bitcoin-testnet';
        expect(subCommandWeight(TWO_LEG_BRIEF)).to.equal(25);
    });

});

describe('batch_limits: what the per-leg AIRDROP weight leaves alone', function () {
    it('leaves DIVIDEND flat at 25 above the gate', function () {
        expect(subCommandWeight(wire('DIVIDEND', '0', 'JDOG', 'XCP', '1'), REGTEST)).to.equal(25);
    });

    it('charges an unreadable AIRDROP one leg, never less', function () {
        expect(subCommandWeight(wire('AIRDROP', 'zz'), REGTEST)).to.equal(25);
        expect(airdropLegCount(['9', 'JDOG'])).to.equal(1);
        expect(airdropLegCount([])).to.equal(1);
    });

    it('sums a mixed batch above the gate', function () {
        expect(batchWeight([TWO_LEG_BRIEF, wire('SEND', '0', 'JDOG', '1', 'addr')], REGTEST)).to.equal(51);
    });
});
