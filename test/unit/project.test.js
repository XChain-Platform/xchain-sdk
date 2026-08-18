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
 * XChain Platform SDK - ProjectHelpers Tests
 *
 * Project registries (protocol/Project_Registry.md): the roster is a
 * TICK-type LIST, attested by a LINK to the project's ISSUE. These
 * tests cover the pure param builders plus the LIST rest-field
 * serialization (multi-item lists as individual pipe segments).
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const ProjectHelpers = require('../../src/project.js');
const { XChainSDK } = require('../../index.js');

describe('ProjectHelpers', function () {

    let project, sdk;
    beforeEach(function () {
        project = new ProjectHelpers();
        sdk = new XChainSDK({ network: 'bitcoin-regtest' });
    });

    describe('rosterParams()', function () {
        it('builds a TICK-type LIST param bundle from an array of ticks', function () {
            const p = project.rosterParams({ ticks: ['PEPECASH', 'DANKMEME', 'RAREPEPE.GENESIS'] });
            expect(p.type).to.equal('1');
            expect(p.item).to.deep.equal(['PEPECASH', 'DANKMEME', 'RAREPEPE.GENESIS']);
        });
        it('coerces a single tick string into a one-item roster', function () {
            const p = project.rosterParams({ ticks: 'PEPECASH' });
            expect(p.item).to.deep.equal(['PEPECASH']);
        });
        it('trims tick names', function () {
            const p = project.rosterParams({ ticks: [' PEPECASH '] });
            expect(p.item).to.deep.equal(['PEPECASH']);
        });
        it('throws on a missing/empty roster', function () {
            expect(() => project.rosterParams({})).to.throw(/ticks is required/);
            expect(() => project.rosterParams({ ticks: [] })).to.throw(/ticks is required/);
            expect(() => project.rosterParams({ ticks: ['  '] })).to.throw(/empty TICK/);
        });
        // The empty segment after TYPE is MEMO, which LIST carries BEFORE its
        // variadic ITEM tail rather than after it: a trailing memo could not be
        // told apart from one more item. A roster with no memo still spends the slot.
        it('serializes to LIST v0 with each tick as its own pipe segment', function () {
            const r = sdk.actions.createAction({ action: 'LIST', params: project.rosterParams({ ticks: ['AAA', 'BBB', 'CCC'] }) });
            expect(r.actionString).to.equal('LIST|0|1||AAA|BBB|CCC');
        });
        it('carries a MEMO in its own slot without consuming a tick', function () {
            const r = sdk.actions.createAction({
                action: 'LIST',
                params: { ...project.rosterParams({ ticks: ['AAA', 'BBB'] }), memo: 'our official tokens' },
            });
            expect(r.actionString).to.equal('LIST|0|1|our official tokens|AAA|BBB');
        });
    });

    describe('rosterEditParams()', function () {
        it('builds an ADD edit (EDIT=1) from an existing roster', function () {
            const p = project.rosterEditParams({ listActionIndex: 1234, add: ['NEWTOKEN'] });
            expect(p).to.deep.include({ edit: '1', listActionIndex: '1234' });
            expect(p.item).to.deep.equal(['NEWTOKEN']);
        });
        it('builds a REMOVE edit (EDIT=2)', function () {
            const p = project.rosterEditParams({ listActionIndex: 1234, remove: ['SCAMTOKEN'] });
            expect(p.edit).to.equal('2');
            expect(p.item).to.deep.equal(['SCAMTOKEN']);
        });
        it('rejects add AND remove in one edit (one EDIT per LIST action)', function () {
            expect(() => project.rosterEditParams({ listActionIndex: 1, add: ['A'], remove: ['B'] })).to.throw(/not both/);
        });
        it('requires listActionIndex and one of add/remove', function () {
            expect(() => project.rosterEditParams({ add: ['A'] })).to.throw(/listActionIndex is required/);
            expect(() => project.rosterEditParams({ listActionIndex: 1 })).to.throw(/add or remove is required/);
        });
        it('serializes to LIST v1 with the edit, source list, and items', function () {
            const r = sdk.actions.createAction({ action: 'LIST', params: project.rosterEditParams({ listActionIndex: 1234, add: ['AAA', 'BBB'] }) });
            expect(r.actionString).to.equal('LIST|1|1|1234||AAA|BBB');
        });
    });

    describe('attestRosterParams()', function () {
        it('builds same-chain LINK params (roster → project ISSUE)', function () {
            const p = project.attestRosterParams({ coin: 'BTC', listActionIndex: 100, issueActionIndex: 42, memo: 'roster v2' });
            expect(p).to.deep.include({ coin1: 'BTC', coin1ActionIndex: '100', coin2: 'BTC', coin2ActionIndex: '42', memo: 'roster v2' });
        });
        it('serializes to a valid LINK action string', function () {
            const r = sdk.actions.createAction({ action: 'LINK', params: project.attestRosterParams({ coin: 'BTC', listActionIndex: 100, issueActionIndex: 42 }) });
            expect(r.actionString).to.match(/^LINK\|0\|BTC\|100\|BTC\|42/);
        });
        it('requires coin and both action indexes', function () {
            expect(() => project.attestRosterParams({ listActionIndex: 1, issueActionIndex: 2 })).to.throw(/coin is required/);
            expect(() => project.attestRosterParams({ coin: 'BTC', issueActionIndex: 2 })).to.throw(/listActionIndex and issueActionIndex/);
            expect(() => project.attestRosterParams({ coin: 'BTC', listActionIndex: 1 })).to.throw(/listActionIndex and issueActionIndex/);
        });
    });

    describe('LIST ITEM rest-field (serialization regression)', function () {
        it('a plain string item still serializes as a single-item list', function () {
            const r = sdk.actions.createAction({ action: 'LIST', params: { type: 1, item: 'ONLYONE' } });
            expect(r.actionString).to.equal('LIST|0|1||ONLYONE');
        });
        it('address lists also expand item arrays', function () {
            const r = sdk.actions.createAction({ action: 'LIST', params: { type: 2, item: ['1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev', '1FWDonkMbC6hL64JiysuggHnUAw2CKWszs'] } });
            expect(r.actionString).to.equal('LIST|0|2||1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev|1FWDonkMbC6hL64JiysuggHnUAw2CKWszs');
        });
    });

    describe('sdk wiring', function () {
        it('sdk.project is a ProjectHelpers instance', function () {
            expect(sdk.project).to.be.an.instanceOf(ProjectHelpers);
        });
        it('sdk.setRoster delegates to workflows.setRoster', function () {
            expect(sdk.setRoster).to.be.a('function');
            expect(sdk.workflows.setRoster).to.be.a('function');
        });
    });

});
