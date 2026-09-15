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
 * XChain Platform SDK - Messaging Utilities
 *
 * ECIES, ECDH, and AES encryption for MESSAGE actions.
 * High-level send/receive with automatic pubkey resolution
 * and message decryption.
 *
 ********************************************************************/

const { getNetwork } = require('../protocol/networks.js');
const ecies = require('./messaging/ecies.js');
const sessionAndAes = require('./messaging/session_and_aes.js');
const messageIo = require('./messaging/message_io.js');
const keyDerivation = require('./messaging/key_derivation.js');


class MessagingUtils {

    constructor(network) {
        this.network = network || null;
        this._netParams = network ? getNetwork(network) : null;
    }

}

Object.assign(
    MessagingUtils.prototype,
    ecies,
    sessionAndAes,
    messageIo,
    keyDerivation
);

module.exports = MessagingUtils;
