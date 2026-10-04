'use strict';

/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 *********************************************************************/

const assert = require('assert');

const constants = require('../../../../src/actions/messaging/kdf_constants.js');

describe('messaging KDF constants', function() {
    it('pins every exported numeric constant', function() {
        const numericExports = Object.fromEntries(
            Object.entries(constants).filter(([, value]) => typeof value === 'number')
        );

        assert.deepStrictEqual(numericExports, {
            EPHEMERAL_PUBKEY_LEN: 33,
            IV_LEN: 12,
            AUTH_TAG_LEN: 16,
            ECIES_OVERHEAD: 61,
            METHOD_ECIES: 1,
            METHOD_ECDH: 2,
            METHOD_AES: 3,
            KDF_VERSION_V0: 0,
            KDF_VERSION_V1: 1,
            HKDF_KEY_LEN: 32
        });
    });

    it('defines ECIES overhead as the sum of its framing parts', function() {
        assert.strictEqual(
            constants.ECIES_OVERHEAD,
            constants.EPHEMERAL_PUBKEY_LEN + constants.IV_LEN + constants.AUTH_TAG_LEN
        );
    });

    it('assigns pairwise-distinct method values', function() {
        const methods = [constants.METHOD_ECIES, constants.METHOD_ECDH, constants.METHOD_AES];

        for (let left = 0; left < methods.length; left++) {
            for (let right = left + 1; right < methods.length; right++) {
                assert.notStrictEqual(methods[left], methods[right]);
            }
        }
    });
});
