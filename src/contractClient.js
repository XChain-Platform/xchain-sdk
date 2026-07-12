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

        // Reject a truthy-but-non-numeric index (e.g. "abc") at construction rather
        // than letting Number() coerce it to NaN and surface as a malformed
        // `.../contract/NaN` request from every later call.
        let idx = Number(contractActionIndex);
        if (!Number.isInteger(idx) || idx < 0)
            throw new SDKContractError('INVALID_CONTRACT_INDEX',
                'contractActionIndex must be a non-negative integer (a contract ACTION_INDEX)');

        this.sdk = sdk;
        this.contractActionIndex = idx;
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
        return explorer.getExecutions(this.contractActionIndex, 'contract', opts);
    }

    // Get contract token balances (all ticks or a specific tick)
    async getBalance(tick) {
        let explorer = this.sdk._requireExplorer();
        return explorer.getContractBalance(this.contractActionIndex, tick);
    }

    // Get the contract's declared permissions manifest (programmable policy layer).
    // Returns { permissions: string[]|null, maxTakeBps: number|null }: permissions=null
    // means no declared allowlist (unrestricted); maxTakeBps=null means the global cap
    // applies. Delegates to the explorer's normalizing reader.
    async getManifest() {
        let explorer = this.sdk._requireExplorer();
        return explorer.getContractManifest(this.contractActionIndex);
    }

    // Back-compat alias for getManifest(). Reads the cached getInfo() result when
    // present to avoid a second fetch.
    async getPermissions() {
        let info = this._info || await this.getInfo();
        return ContractClient.parseManifest(info);
    }

    // Normalize the manifest off a raw explorer contract object. `permissions` may arrive
    // as a JSON string ('["SEND"]') or an already-parsed array; anything else → null.
    static parseManifest(info) {
        if (!info)
            return { permissions: null, maxTakeBps: null };
        let permissions = null;
        let raw = info.permissions;
        if (Array.isArray(raw)) {
            permissions = raw;
        } else if (typeof raw === 'string' && raw.length) {
            try { let p = JSON.parse(raw); if (Array.isArray(p)) permissions = p; } catch (e) { permissions = null; }
        }
        let mtb = info.max_take_bps;
        let maxTakeBps = (mtb === null || mtb === undefined || mtb === '') ? null : Number(mtb);
        return { permissions, maxTakeBps };
    }

}

module.exports = ContractClient;
