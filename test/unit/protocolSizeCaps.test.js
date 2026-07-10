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
 * Unit: protocol size-cap parity (SDK-internal drift guard).
 *
 * The SDK's copies of the protocol size caps must (a) stay equal to the
 * canonical values in xchain-documentation/protocol/constants.js and (b) be
 * single-sourced inside the SDK so no entry point can drift on its own.
 * The expected values below are pinned deliberately: a cap bump that reaches
 * only some SDK copies (or only this repo) fails here instead of silently
 * mis-sizing DEPLOYs or letting the co-signer gate diverge from the decoder.
 * The cross-service assertion against the live canonical module stays in
 * xchain-e2e-test/test/regression/protocol-size-limits.regression.js.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');

const chunkHelper      = require('../../src/chunkHelper.js');
const Validator        = require('../../src/validator.js');
const ContractUtils    = require('../../src/contracts.js');
const psbtActionDecode = require('../../src/cosigner/psbtActionDecode.js');

// Canonical values: xchain-documentation/protocol/constants.js. Change these
// ONLY as part of a coordinated protocol-wide cap change.
const CANONICAL = {
    MAX_ACTION_DATA_LENGTH:     8192,
    OP_RETURN_PUSH_OVERHEAD:    3,
    MAX_CODE_SIZE:              65536,
    MAX_DEPLOYCHUNK_PART_BYTES: 7800,
    MAX_DEPLOY_CHUNKS:          16,
};

describe('protocol size-cap parity (SDK drift guard)', function () {

    it('chunkHelper carries the canonical action/chunk caps', function () {
        expect(chunkHelper.MAX_ACTION_DATA_LENGTH).to.equal(CANONICAL.MAX_ACTION_DATA_LENGTH);
        expect(chunkHelper.OP_RETURN_PUSH_OVERHEAD).to.equal(CANONICAL.OP_RETURN_PUSH_OVERHEAD);
        expect(chunkHelper.MAX_DEPLOYCHUNK_PART_BYTES).to.equal(CANONICAL.MAX_DEPLOYCHUNK_PART_BYTES);
        expect(chunkHelper.MAX_DEPLOY_CHUNKS).to.equal(CANONICAL.MAX_DEPLOY_CHUNKS);
    });

    it('validator carries the canonical code-size cap', function () {
        expect(Validator.MAX_CODE_SIZE).to.equal(CANONICAL.MAX_CODE_SIZE);
    });

    it('contracts.js rides the validator code-size cap (no shadow literal)', function () {
        expect(ContractUtils.MAX_CODE_SIZE).to.equal(Validator.MAX_CODE_SIZE);
        expect(ContractUtils.MAX_CODE_SIZE).to.equal(CANONICAL.MAX_CODE_SIZE);
    });

    it('co-signer OVERSIZED gate rides the chunkHelper action cap', function () {
        expect(psbtActionDecode.MAX_ACTION_DATA_LENGTH).to.equal(chunkHelper.MAX_ACTION_DATA_LENGTH);
        expect(psbtActionDecode.MAX_ACTION_DATA_LENGTH).to.equal(CANONICAL.MAX_ACTION_DATA_LENGTH);
    });

    it('contracts.js preflight enforces the shared cap behaviorally', function () {
        const utils = new ContractUtils();
        const at   = utils.checkCodeSize('x'.repeat(CANONICAL.MAX_CODE_SIZE));
        const over = utils.checkCodeSize('x'.repeat(CANONICAL.MAX_CODE_SIZE + 1));
        expect(at.withinLimit).to.equal(true);
        expect(over.withinLimit).to.equal(false);
        expect(over.limit).to.equal(CANONICAL.MAX_CODE_SIZE);
    });
});
