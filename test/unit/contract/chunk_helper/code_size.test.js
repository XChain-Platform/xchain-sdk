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
 * Unit: chunkHelper.planDeploy refuses a source over MAX_CODE_SIZE.
 *
 * The indexer refuses an assembled source over MAX_CODE_SIZE UTF-8 bytes only
 * after every carrier transaction is paid, and sixteen 7800-byte slices hold
 * more than that, so the chunk-count limit alone lets the planner hand out a
 * plan the network rejects. These tests pin the byte cap at the planner.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const { planDeploy, splitCode, MAX_DEPLOY_CHUNKS } = require('../../../../src/contract/chunk_helper.js');
const { MAX_CODE_SIZE } = require('../../../../src/protocol/constants.js');

describe('chunkHelper.planDeploy code-size cap @regression', function () {
    it('refuses a source over MAX_CODE_SIZE UTF-8 bytes that still fits in MAX_DEPLOY_CHUNKS slices', function () {
        const over = 'x'.repeat(MAX_CODE_SIZE + 1);
        expect(splitCode(over).length).to.be.at.most(MAX_DEPLOY_CHUNKS);
        expect(() => planDeploy(over, { gasLimit: 100000 }))
            .to.throw('Contract code exceeds 65536 byte limit (65537 bytes)');
    });

    it('plans a source of exactly MAX_CODE_SIZE bytes', function () {
        const plan = planDeploy('x'.repeat(MAX_CODE_SIZE), { gasLimit: 100000 });
        expect(plan.single).to.equal(false);
        expect(plan.totalChunks).to.equal(plan.parts.length);
    });

    it('counts the cap in UTF-8 bytes, not string length, as the indexer does', function () {
        const multi = 'é'.repeat(MAX_CODE_SIZE / 2 + 1);
        expect(multi.length).to.be.below(MAX_CODE_SIZE);
        expect(() => planDeploy(multi, { gasLimit: 100000 })).to.throw(/exceeds 65536 byte limit \(65538 bytes\)/);
    });
});
