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
 ********************************************************************/

'use strict';

const assert = require('assert');
const ExplorerClient = require('../../../../src/clients/explorer.js');
const { buildExplorer } = require('../../../../src/utils/action_waiter/explorer_options.js');

describe('explorer option construction', function () {
    it('returns null without explorer connection options', function () {
        for (const opts of [undefined, null, {}, { network: 'bitcoin-regtest' }]) {
            assert.strictEqual(buildExplorer({}, opts), null);
        }
    });

    it('returns an explicit explorer untouched', function () {
        const explorer = { request: () => {} };

        assert.strictEqual(buildExplorer({}, { explorer, explorerUrl: 'h' }), explorer);
    });

    it('builds an explorer client with SDK network options', function () {
        const explorer = buildExplorer(
            { options: { network: 'bitcoin-regtest' } },
            { explorerUrl: 'h', explorerPort: 8080 }
        );

        assert.ok(explorer instanceof ExplorerClient);
    });

    it('accepts a null SDK when a URL is supplied', function () {
        assert.doesNotThrow(() => buildExplorer(null, { explorerUrl: 'h' }));
    });
});
