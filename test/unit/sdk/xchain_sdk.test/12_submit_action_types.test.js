// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { CREATE_TX_OPTION_FIELDS } = require('../../../../src/clients/encoder/create_tx_options.js');

const DTS = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'index.d.ts'), 'utf8');

function interfaceBody(name) {
    const start = DTS.search(new RegExp('export interface ' + name + '\\b[^\\{]*\\{'));
    assert.ok(start >= 0, 'missing interface ' + name);
    const end = DTS.indexOf('\n}', start);
    assert.ok(end > start, 'unterminated interface ' + name);
    return DTS.slice(start, end);
}

function assertFields(body, fields) {
    for (const field of fields)
        assert.match(body, new RegExp('^ {4}' + field + '\\?:', 'm'), 'missing field ' + field);
}

describe('submitAction option declarations', function () {
    it('declares runtime submit controls and both local caps', function () {
        assertFields(interfaceBody('SubmitActionOpts'), [
            'maxFeeSats', 'maxPhaseFundingSats', 'signer', 'preflight',
            'skipAddressCompaction', 'strictFreshness',
        ]);
    });

    it('keeps EncoderOptions aligned with every forwarded createTx field', function () {
        assertFields(interfaceBody('EncoderOptions'),
            CREATE_TX_OPTION_FIELDS.concat(['maxFeeSats', 'maxPhaseFundingSats']));
    });

    it('fails its field check when a cap declaration is absent', function () {
        const withoutCap = interfaceBody('EncoderOptions')
            .replace(/^ {4}maxFeeSats\?:.*$/m, '');
        assert.throws(() => assertFields(withoutCap, ['maxFeeSats']), /missing field maxFeeSats/);
    });
});
