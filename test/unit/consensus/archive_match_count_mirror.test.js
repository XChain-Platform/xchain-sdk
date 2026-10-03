'use strict';

const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const path = require('path');
const { execFileSync } = require('child_process');

const sdkConstants = require('../../../src/protocol/constants.js');
const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout.js');

const { ARCHIVE_MATCH_COUNT_ACTIVATION } = sdkConstants;

// Name the flag-day maps the SDK exports today, so discovery can never pass on an empty list.
const KNOWN_ACTIVATION_MAPS = [
    'STAKE_WEIGHTED_QUORUM_ACTIVATION',
    'EQUIV_HEADER_ACTIVATION',
    'STATE_COMMITMENT_ACTIVATION',
    'CHECKPOINT_COMMITMENT_ACTIVATION',
    'ANCHOR_REWARD_ACTIVATION',
    'ARCHIVE_REWARD_ACTIVATION',
    'ANCHOR_ACTIVATION',
    'ARCHIVE_MATCH_COUNT_ACTIVATION',
    'CROSS_CHAIN_ROYALTY_ACTIVATION',
];

// Find every exported activation map by name, so a newly added map is compared automatically.
const SDK_ACTIVATION_MAPS = Object.keys(sdkConstants).filter((name) => /_ACTIVATION$/.test(name));

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

function canonicalExports(ctx, what = 'the archive MATCH_COUNT activation mirror') {
    const canon = siblingCheckout(__dirname, canonicalConstants);
    if (canon.usable) return require(canon.path);
    if (!fs.existsSync(canon.path)) {
        skipOrFail(ctx, canon, what);
        return null;
    }
    return requireCommitted(canon.path);
}

describe('archive MATCH_COUNT activation mirror', function () {
    it('pins the activation map', function () {
        assert.deepStrictEqual(ARCHIVE_MATCH_COUNT_ACTIVATION, {
            mainnet: 9999999999,
            'BTC:testnet': 154939,
            'LTC:testnet': 4905307,
            'DOGE:testnet': 67960786,
            testnet: 9999999999,
            regtest: 0,
        });
    });

    it('matches the documentation canon', function () {
        const { ARCHIVE_MATCH_COUNT_ACTIVATION: expected } = canonicalExports(this);
        assert.deepStrictEqual(ARCHIVE_MATCH_COUNT_ACTIVATION, expected);
    });
});

// Wallets and tools require these maps from the SDK, so a canon re-pin must turn this red.
describe('SDK activation maps mirror the documentation canon', function () {
    let canon = null;

    before(function () {
        canon = canonicalExports(this, 'the SDK activation-map mirror');
    });

    it('discovers every known activation map export', function () {
        const missing = KNOWN_ACTIVATION_MAPS.filter((name) => !SDK_ACTIVATION_MAPS.includes(name));
        assert.deepStrictEqual(missing, [], 'src/protocol/constants.js stopped exporting: ' + missing.join(', '));
    });

    SDK_ACTIVATION_MAPS.forEach((name) => {
        it(name + ' equals the documentation canon', function () {
            assert.ok(Object.prototype.hasOwnProperty.call(canon, name),
                'the SDK exports ' + name + ' but xchain-documentation/protocol/constants.js publishes no such map');
            assert.deepStrictEqual(sdkConstants[name], canon[name],
                name + ' diverges from xchain-documentation/protocol/constants.js');
        });
    });
});
