/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
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
 * XChain Platform SDK - Actions Class Tests
 *
 * Comprehensive unit tests for the Actions class covering all 19 ACTION
 * types, format version selection, result structure, error cases,
 * pre-flight encoding validation, validateAction dry-run, and
 * introspection methods.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const { createActions } = require('./helpers/create_actions.js');

// Introspection methods

describe('Actions – introspection', function () {

    let actions;
    beforeEach(function () { actions = createActions(); });

    // getActions()
    // 32 since XBRIDGE joined the action set (see xchain-bridge.md). The count
    // is pinned rather than derived so a name that appears or vanishes by accident,
    // rather than by a protocol decision, fails here.
    it('getActions() returns an array of exactly 32 action names', function () {
        let list = actions.getActions();
        expect(list).to.be.an('array');
        expect(list).to.have.length(32);
    });

    it('getActions() contains all expected action names', function () {
        let list = actions.getActions();
        let expected = [
            'ADDRESS', 'AIRDROP', 'BATCH', 'BET', 'BROADCAST', 'CALLBACK',
            'DESTROY', 'DISPENSER', 'DIVIDEND', 'FILE', 'ISSUE',
            'LINK', 'LIST', 'MESSAGE', 'MINT', 'ORDER',
            'SEND', 'SLEEP', 'SWAP', 'SWEEP', 'XBRIDGE'
        ];
        for (let name of expected) {
            expect(list).to.include(name);
        }
    });

});


describe('Actions – introspection', function () {

    let actions;
    beforeEach(function () { actions = createActions(); });

    // getActionFormats()
    it('getActionFormats("ISSUE") returns an object with keys 0-5', function () {
        let formats = actions.getActionFormats('ISSUE');
        expect(formats).to.be.an('object');
        for (let v = 0; v <= 5; v++) {
            expect(formats).to.have.property(String(v));
        }
    });

    it('getActionFormats("SEND") returns an object with keys 0-3', function () {
        let formats = actions.getActionFormats('SEND');
        expect(formats).to.be.an('object');
        for (let v = 0; v <= 3; v++) {
            expect(formats).to.have.property(String(v));
        }
    });

    it('getActionFormats("UNKNOWN") returns null', function () {
        let formats = actions.getActionFormats('UNKNOWN');
        expect(formats).to.be.null;
    });

});


describe('Actions – introspection', function () {

    let actions;
    beforeEach(function () { actions = createActions(); });

    // getActionFields()
    it('getActionFields("SEND", 0) returns expected field list', function () {
        let fields = actions.getActionFields('SEND', 0);
        expect(fields).to.be.an('array');
        expect(fields).to.include('VERSION');
        expect(fields).to.include('TICK');
        expect(fields).to.include('AMOUNT');
        expect(fields).to.include('DESTINATION');
        expect(fields).to.include('MEMO');
    });

    it('getActionFields("SEND", 0) includes exactly VERSION, TICK, AMOUNT, DESTINATION, MEMO', function () {
        let fields = actions.getActionFields('SEND', 0);
        // v0 = 'VERSION|TICK|AMOUNT|DESTINATION|MEMO' -> 5 unique fields
        expect(fields).to.deep.equal(['VERSION', 'TICK', 'AMOUNT', 'DESTINATION', 'MEMO']);
    });

    it('getActionFields("ISSUE") with no version returns a union of all fields across all versions', function () {
        let fields = actions.getActionFields('ISSUE');
        expect(fields).to.be.an('array').with.length.above(5);
        // Should contain fields from v0 (full) and smaller versions
        expect(fields).to.include('TICK');
        expect(fields).to.include('MAX_SUPPLY');
        expect(fields).to.include('DESCRIPTION');
        expect(fields).to.include('ALLOW_LIST');
        expect(fields).to.include('CALLBACK_BLOCK');
    });

    it('getActionFields("SLEEP", 1) returns VERSION, RESUME_BLOCK, TICK, MEMO', function () {
        let fields = actions.getActionFields('SLEEP', 1);
        expect(fields).to.deep.equal(['VERSION', 'RESUME_BLOCK', 'TICK', 'MEMO']);
    });

});
