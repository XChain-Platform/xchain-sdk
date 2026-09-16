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
 * XChain Platform SDK - plain-language display label for an ACTION name
 *
 * The raw wire names are all-caps protocol verbs (SEND, ISSUE, LIST, …)
 * that mean nothing to a non-technical user. Activity feeds, sign
 * screens, and action pickers translate the verb into a short Title
 * Case noun phrase before rendering. Keys are upper-cased so both
 * protocol names ("ISSUE") and lower-case UI kinds ("issue",
 * "crosschain") resolve through the same map. CROSSCHAIN is the UI
 * kind for the on-chain LINK action.
 *
 * Promoted from xchain-wallet packages/core/src/shared/utils/
 * actionDisplayLabel.js; the wallet re-exports this copy.
 *
 ********************************************************************/

'use strict';

const DISPLAY_MAP = {
    SEND: 'Send',
    RECEIVE: 'Receive',
    ISSUE: 'Issue',
    MINT: 'Mint',
    DESTROY: 'Destroy',
    SWEEP: 'Sweep',
    DISPENSER: 'Dispenser',
    DISPENSE: 'Dispense',
    ORDER: 'Order',
    SWAP: 'Swap',
    DIVIDEND: 'Dividend',
    BROADCAST: 'Broadcast',
    MESSAGE: 'Message',
    AIRDROP: 'Airdrop',
    BATCH: 'Batch',
    CALLBACK: 'Callback',
    COINPAY: 'Coin payment',
    FILE: 'File',
    LINK: 'Cross-chain',
    CROSSCHAIN: 'Cross-chain',
    LIST: 'Recipient list',
    PRICE: 'Price',
    SLEEP: 'Scheduled delay',
    COLLECT: 'Collect rewards',
    DELEGATE: 'Delegate',
    DEPLOY: 'Deploy',
    DEPOSIT: 'Deposit',
    EXECUTE: 'Contract call',
    STAKE: 'Stake',
    UNSTAKE: 'Unstake',
    WITHDRAW: 'Withdraw',
    ADDRESS: 'Address settings',
    VOTE: 'Vote',
};

/*
 * Map a protocol action name (any case) to a plain-language label.
 * Unknown actions degrade to a Title Case humanization of the raw
 * token so a future action still renders something readable.
 */
function actionDisplayLabel(name) {
    if (!name) return '';
    const key = String(name).trim().toUpperCase();
    if (DISPLAY_MAP[key]) return DISPLAY_MAP[key];
    const words = String(name).trim().toLowerCase().replace(/[_-]+/g, ' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
}

module.exports = { actionDisplayLabel, DISPLAY_MAP };
