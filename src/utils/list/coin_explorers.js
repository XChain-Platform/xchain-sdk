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
 * XChain Platform SDK - per-coin explorer client factory
 *
 ********************************************************************/

// Network-name prefix per coin; the tier (mainnet, testnet, regtest) is appended.
const COIN_NETWORK_PREFIX = { BTC: 'bitcoin', LTC: 'litecoin', DOGE: 'dogecoin' };

// One client per coin, sharing the base explorer's url, port, timeout, retry and hooks.
function buildCoinExplorers(explorer, tier, ExplorerClient) {
    return Object.entries(COIN_NETWORK_PREFIX).map(([chain, prefix]) => ({
        explorer: new ExplorerClient({
            network:      prefix + '-' + tier,
            explorerUrl:  explorer.baseUrl,
            explorerPort: explorer.port,
            timeout:      explorer.timeout,
            retry:        explorer.retry,
            hooks:        explorer.hooks
        }),
        chain
    }));
}

module.exports = { COIN_NETWORK_PREFIX, buildCoinExplorers };
