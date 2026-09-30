// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const assert = require('assert');

// Preserve the legacy top-level module paths as compatibility entry points for
// callers that have not yet moved to the feature-oriented directory layout.
// Removing one silently would turn an organizational refactor into a breaking release.

// Bind each compatibility path to its canonical implementation rather than checking
// exports member by member, because consumers may depend on constructors, singleton
// state, or cached module objects retaining the exact same JavaScript identity.

// Keep the complete path map in one table so each compatibility promise receives
// the same assertion and newly retained entry points cannot bypass the shared rule.
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

// Exercise the real module loader for both sides of every pair, which catches missing
// files, incorrect forwarding targets, and wrappers that manufacture replacement exports.

// Generate a separate test case for each shim so a failure names the affected public
// path directly instead of hiding one broken mapping behind a single aggregate result.

// Compare with strict identity to prove the shim is transparent: merely equivalent
// values would not protect instanceof checks or shared mutable state across import paths.
describe('compat shim identity', function () {
    for (const [shimPath, targetPath] of SHIMS) {
        it(`${shimPath.replace('../../', '')} re-exports ${targetPath.replace('../../', '')}`, function () {
            assert.strictEqual(require(shimPath), require(targetPath));
        });
    }
});
