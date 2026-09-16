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
 * XChain Platform SDK - Action Waiter
 *
 * Resolves when the indexer processes a specific transaction.
 * Uses WebSocket events with polling fallback.
 *
 ********************************************************************/

const ExplorerClient = require('../../clients/explorer.js');

// Build an explorer override without adding another class member.
function buildExplorer(sdk, opts) {
    if (!opts) return null;
    if (opts.explorer) return opts.explorer;
    if (!opts.explorerUrl && !opts.explorerPort) return null;
    let sdkOpts = (sdk && sdk.options) || {};
    return new ExplorerClient({
        network:      opts.network      || sdkOpts.network || (sdk && sdk.network),
        explorerUrl:  opts.explorerUrl  || 'localhost',
        explorerPort: opts.explorerPort !== undefined ? parseInt(opts.explorerPort) : undefined,
        timeout:      opts.explorerTimeout || sdkOpts.timeout
    });
}

module.exports = { buildExplorer };
