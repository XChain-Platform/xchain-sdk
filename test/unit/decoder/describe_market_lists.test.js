'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const { parse } = require('../../../src/decoder/parse.js');
const { describe: describeAction } = require('../../../src/decoder/describe.js');

function detailMap(decoded) {
    return Object.fromEntries(decoded.details.map(({ label, value }) => [label, value]));
}

describe('decoder.describe market lists', function () {
    for (const action of ['ORDER', 'SWAP']) {
        it(`${action} create shows its receive address and policy lists`, function () {
            const decoded = describeAction(parse(
                `${action}|0|BTC|GIVE|10|0|DOGE|GET|20|0|DReceive|900000|41|42|market memo`
            ));

            expect(detailMap(decoded)).to.include({
                'Receive address': 'DReceive',
                'Allow list': '41',
                'Block list': '42',
            });
            expect(decoded.details.map(({ label }) => label)).to.not.include('Counterparty');
        });

        it(`${action} create omits empty policy lists`, function () {
            const decoded = describeAction(parse(
                `${action}|0|BTC|GIVE|10|0|DOGE|GET|20|0|DReceive|900000|||market memo`
            ));

            expect(decoded.details.map(({ label }) => label)).to.not.include.members([
                'Allow list',
                'Block list',
            ]);
        });
    }

    it('LIST shows its memo when present', function () {
        const decoded = describeAction(parse('LIST|0|2|trusted recipients|DOne|DTwo'));

        expect(detailMap(decoded)).to.include({
            Items: '2',
            Memo: 'trusted recipients',
        });
    });

    it('LIST omits the memo row when it is empty', function () {
        const decoded = describeAction(parse('LIST|0|2||DOne|DTwo'));

        expect(decoded.details.map(({ label }) => label).includes('Memo')).to.equal(false);
    });
});
