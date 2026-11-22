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
const EventEmitter = require('events');
const fs     = require('fs');
const path   = require('path');

const DTS = path.join(__dirname, '..', '..', '..', 'index.d.ts');
const EXPLORER_DIR = process.env.XCHAIN_EXPLORER_DIR
    || path.join(__dirname, '..', '..', '..', '..', 'xchain-explorer');
const BROADCASTER = path.join(EXPLORER_DIR, 'src', 'ws', 'broadcaster.js');
const SERIALIZE = path.join(EXPLORER_DIR, 'src', 'ws', 'serialize.js');

// The columns each explorer reader selects, after its post-passes.
const CONTRACT_LIST = ['action', 'action_index', 'action_format', 'source', 'code_hash', 'api_version',
    'cooldown_blocks', 'slash_destination', 'meta_name', 'meta_description', 'meta_version', 'meta',
    'block_index', 'timestamp', 'tx_hash', 'tx_index', 'status', 'owner_withdraw'];
const STATE_ROW     = ['id', 'contract_index', 'state_key', 'state_value', 'block_index'];
const BALANCE_ROW   = ['tick', 'amount'];
const EXECUTION_ROW = ['action', 'action_index', 'action_format', 'contract_index', 'caller', 'method_name',
    'gas_used', 'gas_limit', 'emitted_count', 'block_index', 'timestamp', 'tx_hash', 'tx_index', 'status'];
const EXECUTION_DETAIL = ['input_params', 'error_message'];
const WS_BLOCK = ['block_index', 'block_hash', 'block_time', 'tx_count', 'action_count'];
const WS_STATS = ['block_height', 'total_actions'];
const WS_ACTION = ['action_index', 'action', 'tx_hash', 'block_index', 'source', 'status', 'destinations'];

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

const dts = fs.readFileSync(DTS, 'utf8');

function registerDeclarationTests() {
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

    it('declares the three core WebSocket payloads and typed callback surfaces', function () {
        assert.deepStrictEqual(props(interfaceBody(dts, 'WsNewBlockData')).required.sort(), WS_BLOCK.slice().sort());
        assert.deepStrictEqual(props(interfaceBody(dts, 'WsNetworkStatsData')).required.sort(), WS_STATS.slice().sort());
        assert.deepStrictEqual(props(interfaceBody(dts, 'WsNewActionData')).required.sort(), WS_ACTION.slice().sort());
        assert.match(dts, /interface WsFrameEnvelope<T = any>/);
        assert.match(dts, /onBlock\(callback: \(msg: WsNewBlockFrame\)/);
        assert.match(dts, /onAction\(callback: \(msg: WsNewActionFrame\)/);
        assert.match(dts, /onNetworkStats\(callback: \(msg: WsNetworkStatsFrame\)/);
    });

    it('declares the optional fork fields emitted on catch-up reorg refusal', function () {
        const member = dts.match(/resync_required: \{([^}]*)\}/);
        assert.ok(member, 'WsCatchUpEvents has no resync_required member');
        assert.match(member[1], /fork_block_index\?: string/);
        assert.match(member[1], /first_invalid_action_index\?: string/);
    });
}

function registerProducerFrameTest() {
    it('matches the core frames emitted by the explorer producer', async function () {
        if (!fs.existsSync(path.join(EXPLORER_DIR, 'package.json'))) {
            if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but no xchain-explorer checkout at ' + EXPLORER_DIR);
            return this.skip();
        }
        for (const file of [BROADCASTER, SERIALIZE])
            assert.ok(fs.existsSync(file), path.relative(EXPLORER_DIR, file) + ' is missing');
        const Broadcaster = require(BROADCASTER);
        const safeStringify = require(SERIALIZE).safeStringify;
        const frames = [];
        const wsServer = {
            explorer: { db: { getMaxActionIndex: async () => 22 } },
            getClients: () => new Map(),
        };
        const producer = new Broadcaster({ wsServer, changeDetector: new EventEmitter() });
        producer.broadcastToChannel = (coin, channel, frame) => frames.push(frame);
        producer.broadcastToChannelKey = (key, frame) => frames.push(frame);
        producer.onBlock('BTC', { block_index: 12n, block_hash: 'aa', block_time: 34n,
            tx_count: 2n, action_count: 3n });
        await new Promise((resolve) => setImmediate(resolve));
        producer.onAction('BTC', { action_index: 7n, action: 'SEND', tx_hash: 'bb',
            block_index: 12n, source: 'source', status: 'valid', destinations: ['dest'] });
        const wire = frames.map((frame) => JSON.parse(safeStringify(frame)));
        const expected = { NEW_BLOCK: WS_BLOCK, NETWORK_STATS: WS_STATS, NEW_ACTION: WS_ACTION };
        for (const type of Object.keys(expected)) {
            const frame = wire.find((item) => item.type === type);
            assert.ok(frame, 'producer emitted no ' + type + ' frame');
            assert.deepStrictEqual(Object.keys(frame.data).sort(), expected[type].slice().sort());
        }
        assert.strictEqual(typeof wire.find((item) => item.type === 'NEW_BLOCK').data.block_index, 'string');
        assert.strictEqual(typeof wire.find((item) => item.type === 'NETWORK_STATS').data.total_actions, 'string');
        assert.strictEqual(typeof wire.find((item) => item.type === 'NEW_ACTION').data.action_index, 'string');
    });
}

describe('explorer contract row types in index.d.ts', function () {
    registerDeclarationTests();
    registerProducerFrameTest();
});
