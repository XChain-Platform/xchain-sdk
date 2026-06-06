/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Platform SDK - Contract Client
 *
 * Bound client for interacting with a specific deployed contract.
 * Provides a fluent interface for execute, deposit, withdraw,
 * and explorer queries scoped to a single contract.
 *
 ********************************************************************/

const { SDKContractError } = require('./errors.js');


class ContractClient {

    constructor(sdk, contractActionIndex) {
        if (!contractActionIndex && contractActionIndex !== 0)
            throw new SDKContractError('INVALID_CONTRACT_INDEX', 'contractActionIndex is required');

        this.sdk = sdk;
        this.contractActionIndex = Number(contractActionIndex);
        this._info = null;
    }

    // Execute a method on the contract (creates EXECUTE action)
    async call(method, params, encoder) {
        return this.sdk.execute({
            contractActionIndex: this.contractActionIndex,
            method: method,
            params: params || []
        }, encoder);
    }

    // Deposit tokens into the contract (creates DEPOSIT action)
    async deposit(tick, quantity, encoder) {
        return this.sdk.deposit({
            contractActionIndex: this.contractActionIndex,
            tick: tick,
            quantity: quantity
        }, encoder);
    }

    // Withdraw tokens from the contract (creates WITHDRAW action)
    async withdraw(tick, quantity, encoder) {
        return this.sdk.withdraw({
            contractActionIndex: this.contractActionIndex,
            tick: tick,
            quantity: quantity
        }, encoder);
    }

    // Get contract metadata from explorer
    async getInfo() {
        let explorer = this.sdk._requireExplorer();
        let info = await explorer.getContract(this.contractActionIndex);
        this._info = info;
        return info;
    }

    // Get contract state (all keys or a specific key)
    async getState(key) {
        let explorer = this.sdk._requireExplorer();
        return explorer.getContractState(this.contractActionIndex, key);
    }

    // Get contract execution history
    async getExecutions(opts) {
        let explorer = this.sdk._requireExplorer();
        return explorer.getExecutions(this.contractActionIndex, opts);
    }

    // Get contract token balances (all ticks or a specific tick)
    async getBalance(tick) {
        let explorer = this.sdk._requireExplorer();
        return explorer.getContractBalance(this.contractActionIndex, tick);
    }

}

module.exports = ContractClient;
