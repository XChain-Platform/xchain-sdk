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
 * XChain Platform SDK - ControllerHelpers Tests
 *
 * Asserts the bind/unbind builders serialize through createAction to the EXACT
 * ISSUE v6 / ADDRESS v1 wire strings the indexer parses, and that validateAction
 * accepts the clean shapes and rejects the malformed ones.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const ControllerHelpers = require('../../src/controller.js');
const { XChainSDK, ControllerHelpers: ExportedControllerHelpers } = require('../../index.js');

describe('ControllerHelpers', function () {

    let controller, sdk;
    beforeEach(function () {
        controller = new ControllerHelpers();
        sdk = new XChainSDK({ network: 'bitcoin-regtest' });
    });

    // Serialize a params object through the real createAction pipeline.
    function ser(action, params) {
        return sdk.actions.createAction({ action, params }).actionString;
    }

    describe('actionClasses()', function () {
        it('returns the canonical class list matching the indexer', function () {
            expect(controller.actionClasses()).to.deep.equal(['transfer', 'trade', 'burn', 'mint', 'stake']);
        });
        it('returns a fresh copy (callers cannot mutate the canonical list)', function () {
            controller.actionClasses().push('admin');
            expect(controller.actionClasses()).to.deep.equal(['transfer', 'trade', 'burn', 'mint', 'stake']);
        });
    });

    describe('bindToken()', function () {
        it('builds camelCase ISSUE v6 params with UNBIND=0', function () {
            const p = controller.bindToken({ tick: 'MYTOKEN', controller: 42, actionClass: 'transfer', cooldownBlocks: 100, memo: 'm' });
            expect(p).to.include({ tick: 'MYTOKEN', controller: '42', actionClass: 'transfer', cooldownBlocks: '100', unbind: '0', memo: 'm' });
        });
        it('serializes to the EXACT ISSUE v6 wire string (all fields)', function () {
            const wire = ser('ISSUE', controller.bindToken({ tick: 'MYTOKEN', controller: 42, actionClass: 'transfer', cooldownBlocks: 100, memo: 'm' }));
            expect(wire).to.equal('ISSUE|6|MYTOKEN|42|transfer|100|0|m');
        });
        it('serializes a minimal bind (no cooldown/memo) keeping UNBIND=0 in place', function () {
            const wire = ser('ISSUE', controller.bindToken({ tick: 'MYTOKEN', controller: 42, actionClass: 'transfer' }));
            expect(wire).to.equal('ISSUE|6|MYTOKEN|42|transfer||0');
        });
        it('serializes cooldownBlocks=0 (the indexer allows a non-negative cooldown)', function () {
            const wire = ser('ISSUE', controller.bindToken({ tick: 'MYTOKEN', controller: 42, actionClass: 'mint', cooldownBlocks: 0 }));
            expect(wire).to.equal('ISSUE|6|MYTOKEN|42|mint|0|0');
        });
        it('lower-cases the action class on the wire', function () {
            const wire = ser('ISSUE', controller.bindToken({ tick: 'X', controller: 1, actionClass: 'TRADE' }));
            expect(wire).to.equal('ISSUE|6|X|1|trade||0');
        });
        it('validates clean', function () {
            expect(sdk.actions.validateAction('ISSUE', controller.bindToken({ tick: 'X', controller: 1, actionClass: 'transfer' })).valid).to.equal(true);
        });
        it('requires tick', function () {
            expect(() => controller.bindToken({ controller: 1, actionClass: 'transfer' })).to.throw(/tick is required/);
        });
        it('requires controller', function () {
            expect(() => controller.bindToken({ tick: 'X', actionClass: 'transfer' })).to.throw(/controller is required/);
        });
        it('rejects an unknown action class', function () {
            expect(() => controller.bindToken({ tick: 'X', controller: 1, actionClass: 'frobnicate' })).to.throw(/actionClass must be one of/);
        });
        it('requires an action class', function () {
            expect(() => controller.bindToken({ tick: 'X', controller: 1 })).to.throw(/actionClass is required/);
        });
    });

    describe('unbindToken()', function () {
        it('builds ISSUE v6 params with UNBIND=1 and no controller', function () {
            const p = controller.unbindToken({ tick: 'MYTOKEN', actionClass: 'transfer' });
            expect(p).to.include({ tick: 'MYTOKEN', actionClass: 'transfer', unbind: '1' });
            expect(p.controller).to.equal(undefined);
        });
        it('serializes to the EXACT ISSUE v6 unbind wire string (CONTROLLER empty)', function () {
            const wire = ser('ISSUE', controller.unbindToken({ tick: 'MYTOKEN', actionClass: 'transfer' }));
            expect(wire).to.equal('ISSUE|6|MYTOKEN||transfer||1');
        });
        it('validates clean (unbind needs no controller)', function () {
            expect(sdk.actions.validateAction('ISSUE', controller.unbindToken({ tick: 'X', actionClass: 'burn' })).valid).to.equal(true);
        });
        it('requires tick', function () {
            expect(() => controller.unbindToken({ actionClass: 'transfer' })).to.throw(/tick is required/);
        });
        it('rejects an unknown action class', function () {
            expect(() => controller.unbindToken({ tick: 'X', actionClass: 'nope' })).to.throw(/actionClass must be one of/);
        });
    });

    describe('bindAddress()', function () {
        it('builds ADDRESS v1 params with UNBIND=0 (no address — self-signed)', function () {
            const p = controller.bindAddress({ controller: 42, actionClass: 'trade', cooldownBlocks: 50, memo: 'x' });
            expect(p).to.include({ controller: '42', actionClass: 'trade', cooldownBlocks: '50', unbind: '0', memo: 'x' });
        });
        it('serializes to the EXACT ADDRESS v1 wire string (all fields)', function () {
            const wire = ser('ADDRESS', controller.bindAddress({ controller: 42, actionClass: 'trade', cooldownBlocks: 50, memo: 'x' }));
            expect(wire).to.equal('ADDRESS|1|42|trade|50|0|x');
        });
        it('serializes a minimal bind keeping UNBIND=0 in place', function () {
            const wire = ser('ADDRESS', controller.bindAddress({ controller: 7, actionClass: 'burn' }));
            expect(wire).to.equal('ADDRESS|1|7|burn||0');
        });
        it('validates clean', function () {
            expect(sdk.actions.validateAction('ADDRESS', controller.bindAddress({ controller: 1, actionClass: 'stake' })).valid).to.equal(true);
        });
        it('requires controller', function () {
            expect(() => controller.bindAddress({ actionClass: 'trade' })).to.throw(/controller is required/);
        });
        it('rejects an unknown action class', function () {
            expect(() => controller.bindAddress({ controller: 1, actionClass: 'nope' })).to.throw(/actionClass must be one of/);
        });
    });

    describe('unbindAddress()', function () {
        it('builds ADDRESS v1 params with UNBIND=1', function () {
            const p = controller.unbindAddress({ actionClass: 'stake' });
            expect(p).to.include({ actionClass: 'stake', unbind: '1' });
            expect(p.controller).to.equal(undefined);
        });
        it('serializes to the EXACT ADDRESS v1 unbind wire string (CONTROLLER empty)', function () {
            const wire = ser('ADDRESS', controller.unbindAddress({ actionClass: 'stake' }));
            expect(wire).to.equal('ADDRESS|1||stake||1');
        });
        it('validates clean', function () {
            expect(sdk.actions.validateAction('ADDRESS', controller.unbindAddress({ actionClass: 'trade' })).valid).to.equal(true);
        });
        it('rejects an unknown action class', function () {
            expect(() => controller.unbindAddress({ actionClass: 'nope' })).to.throw(/actionClass must be one of/);
        });
    });

    describe('sdk wiring', function () {
        it('exposes sdk.controller as a ControllerHelpers instance', function () {
            expect(sdk.controller).to.be.instanceOf(ControllerHelpers);
        });
        it('is re-exported from the package entry point', function () {
            expect(ExportedControllerHelpers).to.equal(ControllerHelpers);
        });
    });
});
