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
const { SDKValidationError } = require('../../../src/utils/errors.js');
const { createActions } = require('./helpers/create_actions.js');

// Partial unstake / partial claim (trailing optional AMOUNT)

describe('Actions – partial unstake/claim optional AMOUNT', function () {

    const PK = 'a'.repeat(64);
    let actions;
    beforeEach(function () { actions = createActions(); });

    it('UNSTAKE v0 without amount stays byte-identical to the legacy wire', function () {
        let result = actions.createAction({ action: 'UNSTAKE', params: { signingPubkey: PK } });
        expect(result.actionString).to.equal(`UNSTAKE|0|${PK}`);
    });

    it('UNSTAKE v0 with amount appends the trailing field', function () {
        let result = actions.createAction({ action: 'UNSTAKE', params: { signingPubkey: PK, amount: '25.5' } });
        expect(result.actionString).to.equal(`UNSTAKE|0|${PK}|25.5`);
    });

    it('UNSTAKE v1 without amount stays byte-identical to the legacy wire', function () {
        let result = actions.createAction({
            action: 'UNSTAKE',
            params: { signingPubkey: PK, targetContractIndex: 7, tick: 'TOKEN' }
        });
        expect(result.actionString).to.equal(`UNSTAKE|1|${PK}|7|TOKEN`);
    });

    it('UNSTAKE v1 with amount appends the trailing field', function () {
        let result = actions.createAction({
            action: 'UNSTAKE',
            params: { signingPubkey: PK, targetContractIndex: 7, tick: 'TOKEN', amount: '25.5' }
        });
        expect(result.actionString).to.equal(`UNSTAKE|1|${PK}|7|TOKEN|25.5`);
    });

    it('COLLECT without amount stays byte-identical to the legacy wire', function () {
        let result = actions.createAction({ action: 'COLLECT', params: {} });
        expect(result.actionString).to.equal('COLLECT|0');
    });

    it('COLLECT with amount appends the trailing field', function () {
        let result = actions.createAction({ action: 'COLLECT', params: { amount: '10' } });
        expect(result.actionString).to.equal('COLLECT|0|10');
    });

    it('rejects a zero or negative partial amount client-side', function () {
        for (const bad of ['0', '-5']) {
            expect(() => actions.createAction({ action: 'UNSTAKE', params: { signingPubkey: PK, amount: bad } }))
                .to.throw(SDKValidationError);
            expect(() => actions.createAction({ action: 'COLLECT', params: { amount: bad } }))
                .to.throw(SDKValidationError);
        }
    });
});
