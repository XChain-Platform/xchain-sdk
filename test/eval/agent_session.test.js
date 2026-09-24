// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const assert = require('assert');

const SHIMS = [
    ['../../src/actionWaiter.js', '../../src/utils/action_waiter.js'],
    ['../../src/actions.js', '../../src/actions/index.js'],
    ['../../src/batchLimits.js', '../../src/protocol/batch_limits.js'],
    ['../../src/chunkHelper.js', '../../src/contract/chunk_helper.js'],
    ['../../src/compression.js', '../../src/protocol/compression.js'],
    ['../../src/cosigner/coSigner.js', '../../src/cosigner/co_signer.js'],
    ['../../src/cosigner/policyEvaluator.js', '../../src/cosigner/policy_evaluator.js'],
    ['../../src/cosigner/psbtActionDecode.js', '../../src/cosigner/psbt_action_decode.js'],
    ['../../src/cosigner/windowStore.js', '../../src/cosigner/window_store.js'],
    ['../../src/errors.js', '../../src/utils/errors.js'],
    ['../../src/formatSelector.js', '../../src/protocol/format_selector.js'],
    ['../../src/formats.js', '../../src/protocol/formats.js'],
    ['../../src/gatedFile.js', '../../src/actions/gated_file.js'],
    ['../../src/light.js', '../../src/protocol/light_client.js'],
    ['../../src/musig2.js', '../../src/cosigner/musig2.js'],
    ['../../src/networks.js', '../../src/protocol/networks.js'],
    ['../../src/utility.js', '../../src/utils/utility.js'],
    ['../../src/validator.js', '../../src/protocol/validator.js'],
    ['../../src/wallet.js', '../../src/utils/wallet.js'],
    ['../../src/walletSession.js', '../../src/utils/wallet_session.js'],
];

describe('compat shim identity', function () {
    for (const [shimPath, targetPath] of SHIMS) {
        it(`${shimPath.replace('../../', '')} re-exports ${targetPath.replace('../../', '')}`, function () {
            assert.strictEqual(require(shimPath), require(targetPath));
        });
    }
});
