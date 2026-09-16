/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
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
 * XChain Platform SDK - Explorer Client
 *
 * HTTP client wrapping the xchain-explorer REST API endpoints
 *
 ********************************************************************/

const { installMethods } = require('../utils/install_methods.js');

class ExplorerClient {

    constructor(options = {}) {
        this.baseUrl = options.explorerUrl || 'localhost';
        this.port    = options.explorerPort || 8080;
        this.timeout = options.timeout || 30000;
        this.coin    = this.deriveCoinPrefix(options.network);
        this._pool   = options.pool || {};

        // Lazy-readiness hook (awaited once before the first request so the SDK
        // can overlay hub-discovered endpoints). No-op when not supplied.
        this._readyHook = options.readyHook || null;

        // Build the pooled axios client for the current baseUrl/port.
        this.buildClient();

        // Retry configuration (can be overridden via options)
        this.retry = options.retry !== undefined ? options.retry : {};
        // Hooks
        this.hooks = options.hooks || {};
    }

}

installMethods(ExplorerClient.prototype, require('./explorer/transport.js'), require('./explorer/ledger_reads.js'), require('./explorer/activity_reads.js'), require('./explorer/network_reads.js'));

module.exports = ExplorerClient;
