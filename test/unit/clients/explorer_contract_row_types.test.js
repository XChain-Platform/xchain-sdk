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
 ********************************************************************/

// Pins the contract and execution row types in index.d.ts to the snake_case
// rows the explorer readers select, which the SDK passes through unchanged.
// The package has no TypeScript toolchain, so index.d.ts is read as text.

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const DTS = path.join(__dirname, '..', '..', '..', 'index.d.ts');

// The columns each explorer reader selects, after its post-passes.
const CONTRACT_LIST = ['action', 'action_index', 'action_format', 'source', 'code_hash', 'api_version',
    'cooldown_blocks', 'slash_destination', 'meta_name', 'meta_description', 'meta_version', 'meta',
    'block_index', 'timestamp', 'tx_hash', 'tx_index', 'status', 'owner_withdraw'];
const STATE_ROW     = ['id', 'contract_index', 'state_key', 'state_value', 'block_index'];
const BALANCE_ROW   = ['tick', 'amount'];
const EXECUTION_ROW = ['action', 'action_index', 'action_format', 'contract_index', 'caller', 'method_name',
    'gas_used', 'gas_limit', 'emitted_count', 'block_index', 'timestamp', 'tx_hash', 'tx_index', 'status'];
const EXECUTION_DETAIL = ['input_params', 'error_message'];

// Names the explorer never sends, which an earlier declaration promised.
const PHANTOMS = ['actionIndex', 'address', 'owner', 'codeHash', 'deployBlock', 'gasLimit',
    'contractActionIndex', 'method', 'params', 'success', 'gasUsed', 'returnValue', 'key', 'value', 'balance'];

// The body of `export interface <name> { ... }`, up to its closing brace at column 0.
function interfaceBody(dts, name) {
    const start = dts.indexOf('export interface ' + name + ' {');
    assert.ok(start >= 0, 'index.d.ts declares no `export interface ' + name + '`');
    return dts.slice(start, dts.indexOf('\n}', start));
}

// Top-level property names of an interface body, split by optionality.
function props(body) {
    const out = { required: [], optional: [] };
    const re  = /^ {4}(\w+)(\??):/gm;
    let m;
    while ((m = re.exec(body)) !== null) out[m[2] ? 'optional' : 'required'].push(m[1]);
    return out;
}

describe('explorer contract row types in index.d.ts', function () {
    const dts = fs.readFileSync(DTS, 'utf8');

    it('declares the contract list columns and no phantom camelCase fields', function () {
        const body = interfaceBody(dts, 'ContractInfo');
        const all  = [].concat(props(body).required, props(body).optional);
        for (const f of CONTRACT_LIST) assert.ok(all.includes(f), 'ContractInfo lacks ' + f);
        for (const f of PHANTOMS) assert.ok(!all.includes(f), 'ContractInfo still declares ' + f);
        assert.ok(!/\[key: string\]: any/.test(body), 'ContractInfo is open again');
    });

    it('declares exactly the state and balance reader columns', function () {
        assert.deepStrictEqual(props(interfaceBody(dts, 'ContractStateEntry')).required.sort(), STATE_ROW.slice().sort());
        assert.deepStrictEqual(props(interfaceBody(dts, 'ContractBalanceEntry')).required.sort(), BALANCE_ROW.slice().sort());
    });

    it('declares the execution list columns required and the detail columns optional', function () {
        const body = interfaceBody(dts, 'ExecutionInfo');
        assert.deepStrictEqual(props(body).required.sort(), EXECUTION_ROW.slice().sort());
        assert.deepStrictEqual(props(body).optional.sort(), EXECUTION_DETAIL.slice().sort());
        assert.ok(!/\[key: string\]: any/.test(body), 'ExecutionInfo is open again');
    });

    it('types the single-execution, state and balance reads as the list envelope', function () {
        assert.match(dts, /getExecution\(executionActionIndex: number \| string\): Promise<ListEnvelope<ExecutionInfo>>;/);
        assert.match(dts, /getContractState\([^)]*\): Promise<ListEnvelope<ContractStateEntry>>;/);
        assert.match(dts, /getContractBalance\([^)]*\): Promise<ListEnvelope<ContractBalanceEntry>>;/);
        assert.match(dts, /getState\(key\?: string\): Promise<ListEnvelope<ContractStateEntry>>;/);
        assert.match(dts, /getBalance\(tick\?: string\): Promise<ListEnvelope<ContractBalanceEntry>>;/);
    });
});
