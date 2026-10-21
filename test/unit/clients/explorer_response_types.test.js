// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Pins the hand-written ExplorerStatus, NetworkSummary and ListEnvelope declarations in
// index.d.ts to the explorer's published OpenAPI schemas, field by field.
//
// Two layers, the same split as the cross-repo constants gate:
//   1. a pinned field list that runs everywhere, so a rename in index.d.ts
//      reddens this repo on its own; and
//   2. a read of the sibling explorer's served docs/openapi.json, which proves
//      the pinned list still matches the producer. It skips when the sibling is
//      absent, and XCHAIN_REQUIRE_SIBLINGS=1 turns that skip into a failure.
//
// The package has no TypeScript toolchain, so index.d.ts is read as text.

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const REPO_ROOT     = path.join(__dirname, '..', '..', '..');
const DTS           = path.join(REPO_ROOT, 'index.d.ts');
const EXPLORER_SPEC = path.join(path.dirname(REPO_ROOT), 'xchain-explorer', 'docs', 'openapi.json');

// Fields every JSON response may carry that no per-route schema lists.
const ENVELOPE = ['runtime', 'freshness'];

// ExplorerStatus: field -> { map: per-coin map or scalar, nullable: value may be null }.
const STATUS_FIELDS = {
    supported:                 { map: true,  nullable: false },
    available:                 { map: true,  nullable: false },
    hub_config_fetched_at:     { map: false, nullable: true  },
    hub_config_age_seconds:    { map: false, nullable: true  },
    hub_consensus_hash_mismatch:         { map: false, nullable: true  },
    hub_consensus_hash_mismatch_details: { map: false, nullable: false },
    last_block:                { map: true,  nullable: true  },
    last_block_time:           { map: true,  nullable: true  },
    list_any_coin_items:       { map: true,  nullable: false },
    decoder_tip:               { map: true,  nullable: true  },
    decoder_lag_blocks:        { map: true,  nullable: true  },
    tip_age_seconds:           { map: true,  nullable: true  },
    tip_future_seconds:        { map: true,  nullable: true  },
    indexer_state:             { map: true,  nullable: true  },
    next_block_time:           { map: true,  nullable: true  },
    next_block_future_seconds: { map: true,  nullable: true  },
    indexer_wait_clears_at:    { map: true,  nullable: true  },
    stale:                     { map: true,  nullable: false },
    replica_halted:            { map: true,  nullable: true  },
    chain_tip:                 { map: true,  nullable: true  },
    chain_lag_blocks:          { map: true,  nullable: true  },
    decoder_health:            { map: true,  nullable: false },
};

// The /status fields assertFresh() reads; each must stay declared.
const ASSERT_FRESH_READS = ['stale', 'last_block', 'tip_age_seconds', 'replica_halted'];

const NETWORK_FIELDS     = ['network', 'totals', 'fee', 'coin', 'xchain', 'finality'];
const NETWORK_STATE_KEYS = ['block', 'time', 'unconfirmed', 'unconfirmed_node'];

const CONTRACT_FIELDS = {
    action:             true,
    action_index:       false,
    action_format:      true,
    source:             true,
    code_hash:          false,
    api_version:        false,
    cooldown_blocks:    true,
    slash_destination:  true,
    block_index:        true,
    timestamp:          true,
    tx_hash:            true,
    tx_index:           false,
    status:             true,
    owner_withdraw:     true,
    code:               false,
    code_hash_ok:       false,
    methods:            true,
    abi:                true,
    constructor_params: true,
    vm_query_enabled:   false,
    wallet_url:         false,
    permissions_error:  false,
    permissions:        true,
    max_take_bps:       true,
    meta_name:          true,
    meta_description:   true,
    meta_version:       true,
    meta:               true,
};

const EXECUTION_FIELDS = {
    action:         true,
    action_index:   false,
    action_format:  true,
    contract_index: true,
    caller:         true,
    method_name:    true,
    gas_used:       false,
    gas_limit:      false,
    emitted_count:  false,
    block_index:    true,
    timestamp:      true,
    tx_hash:        true,
    tx_index:       true,
    status:         true,
    input_params:   true,
    error_message:  true,
};

const STATE_FIELDS = {
    id:             false,
    contract_index: false,
    state_key:      false,
    state_value:    true,
    block_index:    false,
};

// The body of `export interface <name> { ... }`, up to its closing brace at column 0.
function interfaceBody(dts, name) {
    const start = dts.indexOf('export interface ' + name + ' {');
    assert.ok(start >= 0, 'index.d.ts declares no `export interface ' + name + '`');
    const end = dts.indexOf('\n}', start);
    assert.ok(end > start, 'unterminated interface ' + name);
    return dts.slice(start, end);
}

// Top-level properties of an interface body: four-space indent, one per line.
function topLevelProps(body) {
    const out = {};
    const re  = /^ {4}(\w+)(\??):\s*(.+?);?$/gm;
    let m;
    while ((m = re.exec(body)) !== null) {
        const type   = m[3];
        const mapped = /^\{\s*\[\w+: string\]:\s*(.+?)\s*\}$/.exec(type);
        out[m[1]] = {
            optional: m[2] === '?',
            map:      !!mapped,
            nullable: /\|\s*null\b/.test(mapped ? mapped[1] : type),
            type,
        };
    }
    return out;
}

function assertPinnedNullability(props, fields) {
    const declared = Object.keys(props).filter((k) => !ENVELOPE.includes(k)).sort();
    assert.deepStrictEqual(declared, Object.keys(fields).sort());
    for (const [name, nullable] of Object.entries(fields)) {
        assert.strictEqual(props[name].nullable, nullable, name + ' nullability drifted: ' + props[name].type);
    }
}

// Read the sibling's schema, or skip (or fail under XCHAIN_REQUIRE_SIBLINGS=1).
function explorerSchema(ctx, name) {
    if (!fs.existsSync(EXPLORER_SPEC)) {
        if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1') {
            throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but the explorer spec is missing at ' + EXPLORER_SPEC);
        }
        return ctx.skip();
    }
    const spec   = JSON.parse(fs.readFileSync(EXPLORER_SPEC, 'utf8'));
    const schema = spec.components && spec.components.schemas && spec.components.schemas[name];
    assert.ok(schema && schema.properties, 'explorer OpenAPI has no components.schemas.' + name);
    return schema;
}

// An OpenAPI type is nullable when its type list includes "null".
function schemaNullable(t) {
    return Array.isArray(t) && t.includes('null');
}

function assertSchemaNullability(schema, fields, exact = true) {
    const names = Object.keys(schema.properties).sort();
    if (exact) assert.deepStrictEqual(names, Object.keys(fields).sort());
    for (const name of names) {
        assert.ok(Object.hasOwn(fields, name), name + ': absent from the pinned fields');
        assert.strictEqual(schemaNullable(schema.properties[name].type), fields[name], name + ': nullability disagrees with the explorer schema');
    }
}

describe('explorer response types in index.d.ts', function () {
    const dts = fs.readFileSync(DTS, 'utf8');

    describe('ExplorerStatus', function () {
        const props = topLevelProps(interfaceBody(dts, 'ExplorerStatus'));

        it('getStatus() resolves to ExplorerStatus', function () {
            assert.match(dts, /getStatus\(\): Promise<ExplorerStatus>;/);
        });

        it('declares exactly the pinned fields, each optional, with the pinned shape', function () {
            const declared = Object.keys(props).filter((k) => !ENVELOPE.includes(k)).sort();
            assert.deepStrictEqual(declared, Object.keys(STATUS_FIELDS).sort());
            for (const [name, want] of Object.entries(STATUS_FIELDS)) {
                const got = props[name];
                assert.strictEqual(got.optional, true, name + ' must be optional: an older explorer omits it');
                assert.strictEqual(got.map, want.map, name + ' map/scalar shape drifted: ' + got.type);
                assert.strictEqual(got.nullable, want.nullable, name + ' nullability drifted: ' + got.type);
            }
        });

        it('declares every field assertFresh() reads', function () {
            for (const name of ASSERT_FRESH_READS) assert.ok(props[name], name + ' is read by assertFresh but undeclared');
        });

        it('keeps replica_halted nullable and stale non-nullable', function () {
            // A null replica_halted means unknown; a typed boolean would invite reading it as false.
            assert.strictEqual(props.replica_halted.nullable, true);
            // stale fails closed on the server, so it is never null.
            assert.strictEqual(props.stale.nullable, false);
        });

        it('matches the explorer OpenAPI ExplorerStatus schema', function () {
            const schema = explorerSchema(this, 'ExplorerStatus');
            assert.deepStrictEqual(Object.keys(schema.properties).sort(), Object.keys(STATUS_FIELDS).sort());
            for (const [name, want] of Object.entries(STATUS_FIELDS)) {
                const p      = schema.properties[name];
                const isMap  = !!p.additionalProperties;
                const valueT = isMap ? p.additionalProperties.type : p.type;
                assert.strictEqual(isMap, want.map, name + ': map/scalar disagrees with the explorer schema');
                assert.strictEqual(schemaNullable(valueT), want.nullable, name + ': nullability disagrees with the explorer schema');
            }
            // Every field is optional here because the schema requires none; revisit if that changes.
            assert.strictEqual(schema.required, undefined, 'ExplorerStatus gained a required list; revisit the optional markers');
        });
    });
});

describe('contract explorer response types in index.d.ts', function () {
    const dts = fs.readFileSync(DTS, 'utf8');

    describe('ContractInfo', function () {
        const props = topLevelProps(interfaceBody(dts, 'ContractInfo'));

        it('getContracts() resolves to ContractInfo', function () {
            assert.match(dts, /getContracts\(query\?: string, type\?: string, opts\?: QueryOptions\): Promise<ListEnvelope<ContractInfo>>;/);
        });

        it('declares exactly the reader fields with their SQL nullability', function () {
            assertPinnedNullability(props, CONTRACT_FIELDS);
        });

        it('matches the explorer OpenAPI ContractRow schema', function () {
            assertSchemaNullability(explorerSchema(this, 'ContractRow'), CONTRACT_FIELDS, false);
        });
    });

    describe('ExecutionInfo', function () {
        const props = topLevelProps(interfaceBody(dts, 'ExecutionInfo'));

        it('getExecution() resolves to ExecutionInfo', function () {
            assert.match(dts, /getExecution\(executionActionIndex: number \| string\): Promise<ListEnvelope<ExecutionInfo>>;/);
        });

        it('declares exactly the reader fields with their SQL nullability', function () {
            assertPinnedNullability(props, EXECUTION_FIELDS);
        });

        it('matches the explorer OpenAPI ExecutionDetail schema', function () {
            assertSchemaNullability(explorerSchema(this, 'ExecutionDetail'), EXECUTION_FIELDS);
        });
    });

    describe('ContractStateEntry', function () {
        const props = topLevelProps(interfaceBody(dts, 'ContractStateEntry'));

        it('getContractState() resolves to ContractStateEntry', function () {
            assert.match(dts, /getContractState\(contractActionIndex: number \| string, key\?: string\): Promise<ListEnvelope<ContractStateEntry>>;/);
        });

        it('declares exactly the reader fields with their SQL nullability', function () {
            assertPinnedNullability(props, STATE_FIELDS);
        });

        it('matches the explorer OpenAPI ContractStateEntry schema', function () {
            assertSchemaNullability(explorerSchema(this, 'ContractStateEntry'), STATE_FIELDS);
        });
    });
});

describe('explorer response types in index.d.ts', function () {
    const dts = fs.readFileSync(DTS, 'utf8');

    describe('NetworkSummary', function () {
        const props = topLevelProps(interfaceBody(dts, 'NetworkSummary'));

        it('getNetwork() resolves to NetworkSummary', function () {
            assert.match(dts, /getNetwork\(opts\?: QueryOptions\): Promise<NetworkSummary>;/);
        });

        it('declares exactly the pinned fields and no peer data', function () {
            const declared = Object.keys(props).filter((k) => !ENVELOPE.includes(k)).sort();
            assert.deepStrictEqual(declared, NETWORK_FIELDS.slice().sort());
            assert.ok(!/peer/i.test(interfaceBody(dts, 'NetworkSummary')), 'the /network response carries no peer data');
        });

        it('matches the explorer OpenAPI NetworkResponse schema', function () {
            const schema = explorerSchema(this, 'NetworkResponse');
            const served = Object.keys(schema.properties).filter((k) => !ENVELOPE.includes(k)).sort();
            assert.deepStrictEqual(served, NETWORK_FIELDS.slice().sort());
            assert.deepStrictEqual(Object.keys(schema.properties.network.properties).sort(), NETWORK_STATE_KEYS.slice().sort());
            const body = interfaceBody(dts, 'NetworkSummary');
            for (const key of NETWORK_STATE_KEYS) {
                assert.match(body, new RegExp('^ {8}' + key + '\\??:', 'm'), 'NetworkSummary.network lacks ' + key);
            }
        });
    });
});

// ListEnvelope against ListResponse: the keyset cursor fields a list page carries.
const LIST_FIELDS = {
    data:        { optional: false },
    total:       { optional: false },
    runtime:     { optional: true  },
    next_after:  { optional: true  },
    next_before: { optional: true  },
};

describe('explorer response types in index.d.ts', function () {
    const dts = fs.readFileSync(DTS, 'utf8');

    describe('ListEnvelope', function () {
        const props = topLevelProps(interfaceBody(dts, 'ListEnvelope<T>'));

        it('declares exactly the pinned fields with the pinned optional markers', function () {
            assert.deepStrictEqual(Object.keys(props).sort(), Object.keys(LIST_FIELDS).sort());
            for (const [name, want] of Object.entries(LIST_FIELDS)) {
                assert.strictEqual(props[name].optional, want.optional, name + ' optional marker drifted: ' + props[name].type);
            }
            assert.strictEqual(props.next_after.type, 'string');
            assert.strictEqual(props.next_before.type, 'string');
        });

        it('lets QueryOptions carry the keyset cursors back', function () {
            const query = topLevelProps(interfaceBody(dts, 'QueryOptions'));
            for (const name of ['before', 'after']) {
                assert.ok(query[name] && query[name].optional, 'QueryOptions lacks optional ' + name);
            }
        });

        it('matches the explorer OpenAPI ListResponse schema', function () {
            const schema = explorerSchema(this, 'ListResponse');
            assert.deepStrictEqual(Object.keys(schema.properties).sort(), Object.keys(LIST_FIELDS).sort());
            const required = (schema.required || []).slice().sort();
            const pinnedRequired = Object.keys(LIST_FIELDS).filter((k) => !LIST_FIELDS[k].optional).sort();
            assert.deepStrictEqual(required, pinnedRequired, 'required fields disagree with the optional markers');
            assert.strictEqual(schema.properties.next_after.type, 'string');
            assert.strictEqual(schema.properties.next_before.type, 'string');
        });
    });
});
