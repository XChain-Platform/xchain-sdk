/*
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 */

'use strict';

const { expect } = require('chai');

const { XChainSDK, SDKValidationError } = require('../../../../index.js');

describe('BatchBuilder', () => {

    // tickResolver compacts an ISSUE v6/v7 TICK to `^<id>`, and the chain counts
    // a caret ISSUE as top-level, so build() must keep a dotted child TICK by name.
    const CHILD_IDS = { 'JDOG.1': '^615', 'JDOG.2': '^616', FOO: '^700' };
    const v6 = (tick) => ({ tick, version: 6, controller: '5', action_class: 'transfer' });
    function compactingSdk() {
        const s = new XChainSDK({ network: 'bitcoin-regtest' });
        s.tickResolver.resolve = async (v) => CHILD_IDS[v] || v;
        return s;
    }
    const subCommands = (result) => result.actionString.split('|').slice(2).join('|').split(';');

    it('builds a parent ISSUE plus an ISSUE v6 child edit the resolver would compact', async () => {
        const builder = compactingSdk().batch()
            .issue({ tick: 'JDOG', description: 'parent' })
            .issue(v6('JDOG.1'));
        builder.validate();
        const parts = subCommands(await builder.build());
        expect(parts[1]).to.equal('ISSUE|6|JDOG.1|5|transfer');
    });

    it('builds two ISSUE v6 child edits with no parent, both kept by name', async () => {
        const parts = subCommands(await compactingSdk().batch().issue(v6('JDOG.1')).issue(v6('JDOG.2')).build());
        expect(parts).to.deep.equal(['ISSUE|6|JDOG.1|5|transfer', 'ISSUE|6|JDOG.2|5|transfer']);
    });

    it('still compacts an undotted ISSUE v6 TICK, which stays top-level', async () => {
        const parts = subCommands(await compactingSdk().batch().issue(v6('FOO')).build());
        expect(parts).to.deep.equal(['ISSUE|6|^700|5|transfer']);
        try {
            await compactingSdk().batch().issue(v6('FOO')).issue({ tick: 'JDOG', description: 'p' }).build();
            expect.fail('Expected SDKValidationError to be thrown');
        } catch (err) {
            expect(err).to.be.instanceOf(SDKValidationError);
            expect(err.code).to.equal('BATCH_CONSTRAINT');
        }
    });

    it('leaves a standalone ISSUE v6 child edit compacted', async () => {
        const result = await compactingSdk().createAction({ action: 'ISSUE', params: v6('JDOG.1') });
        expect(result.actionString).to.equal('ISSUE|6|^615|5|transfer');
    });

});
