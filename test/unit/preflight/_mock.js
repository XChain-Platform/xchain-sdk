'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared mock SDK for pre-flight unit suites. A minimal object with a
// stubbed explorer client and the pre-flight engine attached, so tests
// drive Tier 1 / Tier 2 without any network.

const Preflight = require('../../../src/preflight/index.js');

// Build a mock explorer whose methods return canned data. `spec` maps
// method name -> function(...args) or a value; a method returning a
// thrown SDKExplorerError with code EXPLORER_HTTP_404 models "absent".
function mockExplorer(spec = {}) {
    const explorer = {};
    for (const [method, impl] of Object.entries(spec)) {
        explorer[method] = typeof impl === 'function'
            ? async (...args) => impl(...args)
            : async () => impl;
    }
    return explorer;
}

function notFound() {
    const e = new Error('not found');
    e.code = 'EXPLORER_HTTP_404';
    throw e;
}

// A mock SDK with preflight attached. `explorerSpec` stubs endpoints.
function mockSdk({ explorerSpec, preflight = 'report', network = 'bitcoin-regtest' } = {}) {
    const sdk = { config: { network } };
    if (explorerSpec !== null) sdk.explorer = mockExplorer(explorerSpec || {});
    Preflight.attach(sdk, preflight);
    return sdk;
}

module.exports = { mockSdk, mockExplorer, notFound };
