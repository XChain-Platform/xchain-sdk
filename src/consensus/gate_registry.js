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
 * The SDK's activation registry: every flag-day table the twinned carriers
 * at the top of src/ read, as (key, value) rows keyed '<stem>.<EXPORT>',
 * the spelling the fleet's rules digest and signed GATES field already use.
 * The carriers keep their predicates and read their tables from here, so a
 * table lives in ONE place per repo and a moved carrier can no longer read
 * as "not yet active".
 *
 * This file is the ENTRY. The rows live in the part files under
 * gate_registry/: shared_rows_1.js to shared_rows_5.js are BYTE TWINS of
 * xchain-indexer/src/protocol_changes/shared_rows_1.js to _5.js (the SHARED
 * block every consumer of this platform judges), shared_rows.js is the twin
 * of the queue they write into and regtest_env.js the twin of the arming
 * grammar it reads, and core.js is the consumer core the other consumers copy
 * byte for byte. Copy with cp, prove with cmp: nothing in a twin is edited
 * here, and no key, spelling or order in the block changes inside a window.
 *
 * REGTEST ARMING is applied WHEN A ROW IS READ (shared_rows.js registerRows
 * installs it as the core's read overlay): each block row REGTEST_ARMING
 * lists commits a bare regtest entry, the registry stores that committed
 * table, and every get(), copy(), rows() and activeAt() arms the entry from
 * this process's environment as it stands at that moment. The overlay reads
 * through config.js's env getters, never process.env directly, per
 * CODE-STYLE.md's module-shape rule; registryEnv below is a live read-through
 * (getter-backed) view with one getter per variable the arming grammar reads
 * (ENV_READERS in shared_rows.js), which gate_registry_env_coverage.test.js pins.
 *
 * Readers get(), copy(), has(), keys(), rows() and activeAt(). A miss THROWS a
 * RegistryMissError naming the key: a row a build lacks is a build defect and
 * never a network state. Nothing may add a row after this module loads.
 *
 * SDK-ONLY GATES: none. Every twinned carrier's table is in the SHARED
 * block, so this repo registers no rows of its own.
 *
 ********************************************************************/

'use strict';

const core = require('./gate_registry/core.js');
const { registerRows } = require('./gate_registry/shared_rows.js');
const { env: sdkEnv } = require('../config.js');

// The SHARED block, loaded for effect: each part queues its rows into
// shared_rows.js as it loads; registerRows() below replays them, in part
// order, into the one registry and installs the venue's regtest arming as
// its read overlay.
require('./gate_registry/shared_rows_1.js');
require('./gate_registry/shared_rows_2.js');
require('./gate_registry/shared_rows_3.js');
require('./gate_registry/shared_rows_4.js');
require('./gate_registry/shared_rows_5.js');

// The arming grammar reads env[rule.env] by the literal variable name on
// every call (regtest_env.js), so this must stay a live view rather than a
// snapshot object; each property is a getter over config.js's own reader.
const registryEnv = {
    get XC_ANCHOR_FOLD_REGTEST_ACTIVATION() { return sdkEnv.anchorFoldRegtestActivation(); },
    get XC_ROLLCALL_REGTEST_ACTIVATION() { return sdkEnv.rollcallRegtestActivation(); },
    get XC_ROLLCALL_GATES_REGTEST_ACTIVATION() { return sdkEnv.rollcallGatesRegtestActivation(); },
    get XC_MIRROR_ADMISSION_ACTIVATION() { return sdkEnv.mirrorAdmissionRegtestActivation(); },
    get XC_ANCHOR_STAKE_REGTEST_ACTIVATION() { return sdkEnv.anchorStakeRegtestActivation(); },
    get XC_ANCHOR_SLASH_REGTEST_ACTIVATION() { return sdkEnv.anchorSlashRegtestActivation(); },
    get XC_AMOUNTS_PRICE_REGTEST_ACTIVATION() { return sdkEnv.amountsPriceRegtestActivation(); },
    get XC_AMOUNTS_PRICE_REGTEST_TIME() { return sdkEnv.amountsPriceRegtestTime(); },
    get XC_CONTRACTS_REGTEST_ACTIVATION() { return sdkEnv.contractsRegtestActivation(); },
    get XC_LISTS_MARKET_REGTEST_ACTIVATION() { return sdkEnv.listsMarketRegtestActivation(); },
    get XC_LISTS_MARKET_REGTEST_TIME() { return sdkEnv.listsMarketRegtestTime(); },
};

const { registry } = core;
registerRows(registry, registryEnv);

module.exports = {
    get: (key) => registry.get(key),
    copy: (key) => registry.copy(key),
    has: (key) => registry.has(key),
    keys: () => registry.keys(),
    rows: () => registry.rows(),
    activeAt: (key, network, coin, height, time) => registry.activeAt(key, network, coin, height, time),
    UNARMED: core.UNARMED,
    UNPINNED: core.UNPINNED,
    RegistryMissError: core.RegistryMissError,
    // Expose the live arming view so pre-flight mirrors arm from the same readers.
    armingEnv: registryEnv,
};
