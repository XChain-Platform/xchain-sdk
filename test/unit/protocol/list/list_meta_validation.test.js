/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * XChain Platform SDK - LIST metadata validation
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const Actions = require('../../../../src/actions/index.js');
const Utility = require('../../../../src/utils/utility.js');
const Validator = require('../../../../src/protocol/validator.js');
const formats = require('../../../../src/protocol/formats.js');
const FormatSelector = require('../../../../src/protocol/format_selector.js');
const {
    LIST_META_NAME_MAX_BYTES,
    LIST_META_DESCRIPTION_MAX_BYTES,
} = require('../../../../src/protocol/validator/field_limits.js');

const META_FIELDS = [
    { field: 'NAME', key: 'name', maxBytes: LIST_META_NAME_MAX_BYTES },
    { field: 'DESCRIPTION', key: 'description', maxBytes: LIST_META_DESCRIPTION_MAX_BYTES },
];

function validate(fields, action = 'LIST') {
    return new Validator(new Utility()).validate(action, fields);
}

function verdicts(fields) {
    return validate(fields).map(error => error.message).filter(message => message.startsWith('invalid: '));
}

function create(params) {
    return new Actions({ config: {}, util: new Utility() })
        .createAction({ action: 'LIST', params });
}

function registerMetadataFieldTests({ field, key, maxBytes }) {
    describe(field, function () {
        const fields = (value, version = 4) => version === 4
            ? { VERSION: 4, TYPE: 1, ITEM: 'JDOG', [field]: value }
            : { VERSION: 5, LIST_ACTION_INDEX: 17, [field]: value };

        it('reports pipe, semicolon, length, and grammar verdicts in indexer order', function () {
            expect(validate(fields('|;' + 'a'.repeat(maxBytes)))[0].message).to.equal('invalid: ' + field + ' (pipe)');
            expect(validate(fields(';' + 'a'.repeat(maxBytes)))[0].message).to.equal('invalid: ' + field + ' (semicolon)');
            expect(validate(fields('a'.repeat(maxBytes + 1)))[0].message).to.equal('invalid: ' + field + ' (length)');
            expect(validate(fields('\u202E'))[0].message).to.equal('invalid: ' + field + ' (format)');
        });

        it('measures the cap in UTF-8 bytes', function () {
            const atCap = 'a'.repeat(maxBytes - 4) + '\u{1F600}';
            const overCap = 'a'.repeat(maxBytes - 3) + '\u{1F600}';
            expect(Buffer.byteLength(atCap, 'utf8')).to.equal(maxBytes);
            expect(verdicts(fields(atCap))).to.deep.equal([]);
            expect(verdicts(fields(overCap))).to.include('invalid: ' + field + ' (length)');
        });

        it('refuses untrimmed, bidi, line-feed, and lone-surrogate text', function () {
            for (const value of ['\u00A0leading', 'trailing ', 'text\u202Etext', 'line\nfeed', '\uD800'])
                expect(verdicts(fields(value)), JSON.stringify(value)).to.include('invalid: ' + field + ' (format)');
        });

        it('refuses the clear sentinel on create and accepts it on set', function () {
            expect(verdicts(fields('-', 4))).to.include('invalid: ' + field + ' (format)');
            expect(verdicts(fields('-', 5))).to.deep.equal([]);
            expect(create({ version: 5, listActionIndex: 17, [key]: '-' }).version).to.equal(5);
        });
    });
}

describe('LIST metadata formats and validation', function () {
    it('publishes the create-with-meta and set-meta wire formats', function () {
        expect(formats.LIST[4]).to.equal('VERSION|TYPE|NAME|DESCRIPTION|MEMO|...ITEM');
        expect(formats.LIST[5]).to.equal('VERSION|LIST_ACTION_INDEX|NAME|DESCRIPTION|MEMO');
    });

    it('serializes format 4 and format 5 without dropping metadata', function () {
        expect(create({ version: 4, type: 1, name: 'Tokens', description: 'Official', item: 'JDOG' }).actionString)
            .to.equal('LIST|4|1|Tokens|Official||JDOG');
        expect(create({ version: 5, listActionIndex: 17, name: 'Renamed', description: '-', memo: 'meta' }).actionString)
            .to.equal('LIST|5|17|Renamed|-|meta');
    });

    it('requires metadata formats to be pinned', function () {
        expect(() => create({ type: 1, name: 'Tokens', item: 'JDOG' }))
            .to.throw(/No format version for LIST/);
        expect(FormatSelector.select('LIST', { TYPE: 1, ITEM: 'JDOG' }).version).to.equal(0);
        expect(() => create({ listActionIndex: 17, name: 'Renamed' }))
            .to.throw(/No format version for LIST/);
        expect(FormatSelector.select('LIST', { LIST_ACTION_INDEX: 17, MEMO: 'meta' }).version).to.equal(1);
    });

    it('accepts empty metadata on create and refuses an empty set as no change', function () {
        expect(create({ version: 4, type: 1, item: 'JDOG' }).actionString)
            .to.equal('LIST|4|1||||JDOG');
        expect(verdicts({ VERSION: 5, LIST_ACTION_INDEX: 17 }))
            .to.include('invalid: NAME (no change)');
    });

    it('requires a positive list index for format 5', function () {
        for (const listActionIndex of [undefined, 0, -1, 1.5, 'nope']) {
            const fields = { LIST_ACTION_INDEX: listActionIndex, NAME: 'Renamed' };
            if (listActionIndex === undefined) fields.VERSION = 5;
            const errors = validate(fields);
            expect(errors.some(error => error.details.field === 'LIST_ACTION_INDEX')).to.equal(true);
        }
    });

    for (const field of META_FIELDS) registerMetadataFieldTests(field);

    it('does not apply the ISSUE 250-character DESCRIPTION cap to LIST', function () {
        const description = 'd'.repeat(251);
        expect(verdicts({ VERSION: 4, TYPE: 1, ITEM: 'JDOG', DESCRIPTION: description })).to.deep.equal([]);
        expect(validate({ VERSION: 0, TICK: 'JDOG', DESCRIPTION: description }, 'ISSUE')
            .some(error => error.details.field === 'DESCRIPTION')).to.equal(true);
    });

    it('keeps FILE NAME and ISSUE DESCRIPTION delimiter checks', function () {
        expect(validate({ NAME: 'bad|name', TYPE: 1 }, 'FILE')
            .some(error => error.code === 'FORBIDDEN_CHARACTER')).to.equal(true);
        expect(validate({ TICK: 'JDOG', DESCRIPTION: 'bad;description' }, 'ISSUE')
            .some(error => error.code === 'FORBIDDEN_CHARACTER')).to.equal(true);
    });
});
