// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const ContractClient = require('../../../src/contract/client.js');

describe('ContractClient.parseManifest permissionsError', function () {
    it('is true when the explorer reports permissions_error', function () {
        for (let flag of [true, 1, '1', 'true']) {
            let m = ContractClient.parseManifest({ permissions: null, permissions_error: flag });
            assert.strictEqual(m.permissionsError, true);
            assert.strictEqual(m.permissions, null);
        }
    });
    it('is true when permissions is an unparseable string', function () {
        assert.strictEqual(ContractClient.parseManifest({ permissions: 'not-json' }).permissionsError, true);
    });
    it('is true when permissions parses to a non-array', function () {
        assert.strictEqual(ContractClient.parseManifest({ permissions: '{"a":1}' }).permissionsError, true);
    });
    it('is true when permissions is a non-array, non-string value', function () {
        assert.strictEqual(ContractClient.parseManifest({ permissions: 5 }).permissionsError, true);
        assert.strictEqual(ContractClient.parseManifest({ permissions: { a: 1 } }).permissionsError, true);
    });
    it('is absent for readable, null, empty and missing permissions', function () {
        for (let info of [null, {}, { permissions: null }, { permissions: '' }, { permissions: '["SEND"]' },
            { permissions: ['SEND'] }, { permissions: [], permissions_error: false }, { permissions_error: 0 }]) {
            assert.ok(!('permissionsError' in ContractClient.parseManifest(info)), JSON.stringify(info));
        }
    });
});
