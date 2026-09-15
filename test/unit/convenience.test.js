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

// Convenience methods and BatchBuilder tests: module entry point exports,
// convenience action methods on XChainSDK, and the BatchBuilder fluent API,
// validation, and independence.

'use strict';

const { expect } = require('chai');

const ADDR = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';

describe('Module entry point', () => {

    it('exports XChainSDK', () => {
        const mod = require('../../index.js');
        expect(mod).to.have.property('XChainSDK');
        expect(mod.XChainSDK).to.be.a('function');
    });

    it('exports BatchBuilder', () => {
        const mod = require('../../index.js');
        expect(mod).to.have.property('BatchBuilder');
        expect(mod.BatchBuilder).to.be.a('function');
    });

    it('exports all error classes', () => {
        const mod = require('../../index.js');
        const errorClasses = [
            'SDKError',
            'SDKValidationError',
            'SDKFormatError',
            'SDKEncoderError',
            'SDKExplorerError',
            'SDKHubError',
            'SDKConfigError'
        ];
        for (let name of errorClasses) {
            expect(mod, `missing export: ${name}`).to.have.property(name);
            expect(mod[name]).to.be.a('function');
        }
    });

    it('new XChainSDK() constructs successfully from the entry point', () => {
        const { XChainSDK } = require('../../index.js');
        const sdk = new XChainSDK({ network: 'bitcoin-regtest' });
        expect(sdk).to.be.an.instanceOf(XChainSDK);
    });

    it('default export equals XChainSDK', () => {
        const mod = require('../../index.js');
        expect(mod.default).to.equal(mod.XChainSDK);
    });

});
