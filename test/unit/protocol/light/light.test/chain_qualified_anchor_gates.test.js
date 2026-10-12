'use strict';

const assert = require('assert');

const GATE_PATH = require.resolve('../../../../../src/consensus/gate_registry.js');
const ANCHOR_PATH = require.resolve('../../../../../src/protocol/light_client/anchored_checkpoint.js');
const ORDER_PATH = require.resolve('../../../../../src/protocol/light_client/anchor_bundle_order.js');
const REAL_GATE = require(GATE_PATH);

async function withChainQualifiedGates(run) {
    const savedGate = require.cache[GATE_PATH];
    const savedAnchor = require.cache[ANCHOR_PATH];
    const savedOrder = require.cache[ORDER_PATH];
    const calls = [];
    require.cache[GATE_PATH] = {
        id: GATE_PATH, filename: GATE_PATH, loaded: true,
        exports: Object.assign({}, REAL_GATE, { activeAt(key, network, coin, height, time) {
            calls.push({ key, network, coin, height, time });
            return network === 'testnet' && coin === 'DOGE' && Number(height) >= 1500;
        } })
    };
    delete require.cache[ANCHOR_PATH];
    delete require.cache[ORDER_PATH];
    try {
        return await run({
            anchor: require(ANCHOR_PATH),
            order: require(ORDER_PATH),
            calls
        });
    } finally {
        if (savedGate) require.cache[GATE_PATH] = savedGate;
        else delete require.cache[GATE_PATH];
        if (savedAnchor) require.cache[ANCHOR_PATH] = savedAnchor;
        else delete require.cache[ANCHOR_PATH];
        if (savedOrder) require.cache[ORDER_PATH] = savedOrder;
        else delete require.cache[ORDER_PATH];
    }
}

function section(chain) {
    const hash = '01'.repeat(32);
    return [chain, 123, hash, hash, hash, hash, 7, 2000,
        hash, 1, hash, 1, 1, '02'.repeat(32), '03'.repeat(64)];
}

function descendingBundle() {
    return [0, 'testnet', 2000, 2, ...section('DOGE'), ...section('BTC'),
        '04'.repeat(32), 0].join('|');
}

function foldRow() {
    return {
        version: 3, network: 'testnet', chain: 'BTC', block_index: 123,
        block_index_doge: 2000, checkpoint_seq: 7, snapshot_block: 2000,
        state_root: '05'.repeat(32), state_root_version: 1,
        block_merkle_root: '06'.repeat(32), block_merkle_version: 1,
        validator_signatures: []
    };
}

describe('chain-qualified ANCHOR gate fixtures', function () {
    it('enforces bundle order through the DOGE-qualified cut', async function () {
        await withChainQualifiedGates(async ({ anchor, order, calls }) => {
            assert.strictEqual(order.bundleOrderEnforced('testnet', 2000), true);
            assert.throws(() => anchor.parseAnchorV0(descendingBundle(), { blockIndex: 2000 }),
                { message: 'LightClient: ANCHOR sections not CHAIN-ascending' });
            assert.deepStrictEqual(calls.slice(0, 2).map(call => call.coin), ['DOGE', 'DOGE']);
        });
    });

    it('admits a v3 row through the DOGE-qualified fold cut', async function () {
        await withChainQualifiedGates(async ({ anchor, calls }) => {
            const fetchImpl = async () => ({ ok: true, status: 200,
                json: async () => ({ data: [foldRow()] }) });
            const result = await anchor.fetchAnchoredCheckpoint({
                explorerUrl: 'https://fixture.invalid', dogeCoin: 'DOGE', targetChain: 'BTC',
                validators: [], dogeTipHeight: 2100, minDepth: 60, fetchImpl
            });
            assert.strictEqual(result.reason, 'ROOTS_NOT_SIGNED');
            assert.strictEqual(calls[0].coin, 'DOGE');
        });
    });
});
