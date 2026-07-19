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
 * XChain Platform SDK - HD derivation contract (review item 2760)
 *
 * Advisory, documentation-only anchor for the wallet<->backend coin-type
 * parity contract. The SDK performs no HD derivation itself, so this data is
 * never consumed on a consensus or signing path; it exists so the wallet's
 * cross-repo derivation-parity test has a backend-side value to assert against
 * rather than checking a wallet-internal constant against itself.
 *
 * FAMILY_SLIP44 is family-scoped (per coin, NOT per network): the mainnet-slot
 * contract requires testnet and regtest to reuse the mainnet coin type, so a
 * single value per coin is deliberate. Values are the registered mainnet
 * SLIP-44 coin types and match the wallet HD descriptors at
 * xchain-wallet/packages/core/src/registry/descriptors/{bitcoin,litecoin,dogecoin}.js
 * (m/44'/0'|2'|3').
 *
 * NOTE: this lives in a standalone module, NOT on src/coins/*.js, because the
 * coin modules are consensus-critical and vendored byte-identically from the
 * canonical xchain-hub/src/coins registry (enforced by
 * test/unit/coins-conformance.test.js). Adding a field there would fork the
 * pinned copies. If a backend component ever performs HD derivation, it should
 * consume FAMILY_SLIP44 from here rather than hand-copying the value a fourth
 * time.
 *
 *********************************************************************/

'use strict';

// Mainnet SLIP-44 coin type per coin family.
const FAMILY_SLIP44 = {
    BTC: 0,
    LTC: 2,
    DOGE: 3,
};

module.exports = { FAMILY_SLIP44 };
