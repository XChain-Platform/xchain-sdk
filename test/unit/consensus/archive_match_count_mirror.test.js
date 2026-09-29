'use strict';

const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const path = require('path');
const { execFileSync } = require('child_process');

const { ARCHIVE_MATCH_COUNT_ACTIVATION } = require('../../../src/protocol/constants.js');
const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout.js');

const docsDir = process.env.XCHAIN_DOCS_DIR
    || path.join(__dirname, '..', '..', '..', '..', 'xchain-documentation');
const canonicalConstants = path.join(docsDir, 'protocol', 'constants.js');

function requireCommitted(canonicalPath) {
    const root = path.dirname(path.dirname(fs.realpathSync(canonicalPath)));
    const source = execFileSync('git', ['-C', root, 'show', 'HEAD:protocol/constants.js'], {
        encoding: 'utf8',
    });
    const canonicalModule = new Module(canonicalPath, module);
    canonicalModule.filename = canonicalPath;
    canonicalModule.paths = Module._nodeModulePaths(root);
    canonicalModule._compile(source, canonicalPath);
    return canonicalModule.exports;
}

function canonicalExports(ctx) {
    const canon = siblingCheckout(__dirname, canonicalConstants);
    if (canon.usable) return require(canon.path);
    if (!fs.existsSync(canon.path)) {
        skipOrFail(ctx, canon, 'the archive MATCH_COUNT activation mirror');
        return null;
    }
    return requireCommitted(canon.path);
}

describe('archive MATCH_COUNT activation mirror', function () {
    it('pins the activation map', function () {
        assert.deepStrictEqual(ARCHIVE_MATCH_COUNT_ACTIVATION, {
            mainnet: 9999999999,
            testnet: 9999999999,
            regtest: 0,
        });
    });

    it('matches the documentation canon', function () {
        const { ARCHIVE_MATCH_COUNT_ACTIVATION: expected } = canonicalExports(this);
        assert.deepStrictEqual(ARCHIVE_MATCH_COUNT_ACTIVATION, expected);
    });
});
