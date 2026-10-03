/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

const gateRegistry = require('../../consensus/gate_registry');

function bundleOrderEnforced(network, blockIndex) {
    if (!Number.isFinite(blockIndex)) return false;
    return gateRegistry.activeAt(
        'anchor_bundle_order_activation.ANCHOR_BUNDLE_ORDER_ACTIVATION',
        network, 'DOGE', blockIndex, null
    );
}

function bundleOrderRefusal(sections, reasons) {
    if (reasons.sectionsChainOrderReason(sections))
        return 'LightClient: ANCHOR sections not CHAIN-ascending';
    for (let i = 0; i < sections.length; i++) {
        if (reasons.sigsPubkeyOrderReason(sections[i].validator_signatures))
            return 'LightClient: ANCHOR section ' + i + ' signatures not PUBKEY-ascending';
    }
    return null;
}

module.exports = { bundleOrderEnforced, bundleOrderRefusal };
