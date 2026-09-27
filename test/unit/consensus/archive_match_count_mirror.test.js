'use strict';

const assert = require('assert');
const path = require('path');

const { ARCHIVE_MATCH_COUNT_ACTIVATION } = require('../../../src/protocol/constants.js');
const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout.js');

const docsDir = process.env.XCHAIN_DOCS_DIR
    || path.join(__dirname, '..', '..', '..', '..', 'xchain-documentation');
const canonicalConstants = path.join(docsDir, 'protocol', 'constants.js');

describe('archive MATCH_COUNT activation mirror', function () {
    it('pins the activation map', function () {
        assert.deepStrictEqual(ARCHIVE_MATCH_COUNT_ACTIVATION, {
            mainnet: 9999999999,
            testnet: 9999999999,
            regtest: 0,
        });
    });

    it('matches the documentation canon', function () {
        const canon = siblingCheckout(__dirname, canonicalConstants);
        if (!canon.usable)
            return skipOrFail(this, canon, 'the archive MATCH_COUNT activation mirror');

        const { ARCHIVE_MATCH_COUNT_ACTIVATION: expected } = require(canon.path);
        assert.deepStrictEqual(ARCHIVE_MATCH_COUNT_ACTIVATION, expected);
    });
});
