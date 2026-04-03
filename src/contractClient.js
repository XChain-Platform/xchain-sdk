/*********************************************************************
 *
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 *
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided "AS IS", without warranties or conditions of any kind.
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
