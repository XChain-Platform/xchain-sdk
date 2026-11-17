'use strict';

const assert = require('assert');
const crypto = require('crypto');
const Module = require('module');
const { createFakeMultipartChain } = require('../../helpers/multipart_fake_chain.js');
const funding = require('../../../src/file/multipart_funding.js');
const fundingMatch = require('../../../src/file/multipart_funding_match.js');
const progress = require('../../../src/file/multipart_progress.js');
const resume = require('../../../src/file/multipart_resume.js');
const lane = require('../../../src/file/multipart_lane.js');

const WORKFLOW = '../../../src/actions/workflows/file_multipart_publish.js';

function standardPlan() {
    const parts = Array.from({ length: 250 }, (_, partIndex) => {
        const rawData = Buffer.from([partIndex % 251]);
        const digest = crypto.createHash('sha256').update(rawData).digest('hex');
        return { partIndex, rawData, digest,
            params: { version: 2, fileHash: '', partIndex } };
    });
    const fileHash = crypto.createHash('sha256')
        .update(Buffer.concat(parts.map(part => Buffer.from(part.digest, 'hex')))).digest('hex');
    parts.forEach(part => { part.params.fileHash = fileHash; });
    return { fileHash, totalParts: parts.length, parts,
        manifestParams: { version: 1, fileHash, totalParts: parts.length,
            totalBytes: parts.reduce((sum, part) => sum + part.rawData.length, 0) } };
}

function workflowModules(plan) {
    return Object.assign({}, funding, fundingMatch, progress, resume, lane, {
        planMultipartFile: async () => plan,
        assertMultipartActive: () => true,
        readRecentBlockTimes: async () => Array(11).fill(200),
        pieceCreateTxParams: args => ({ piece: args.data, utxos: [args.utxo] }),
        reconcileEncoded: () => true,
    });
}

function installModules(modules) {
    const original = Module['_load'];
    Module['_load'] = function (request, parent, isMain) {
        if (parent && /file_multipart_publish\.js$/.test(parent.filename)
            && (request.includes('/file/') || request.includes('/action_waiter/')
                || request.includes('/carrier/'))) return modules;
        return original.call(this, request, parent, isMain);
    };
    delete require.cache[require.resolve(WORKFLOW)];
    return () => { Module['_load'] = original; delete require.cache[require.resolve(WORKFLOW)]; };
}

function addToChain(chain, plan, actionData, txid) {
    const manifest = actionData.params.version === 1;
    const partIndex = manifest ? null : actionData.params.partIndex;
    chain.addPiece({ kind: manifest ? 'manifest' : 'part', source: 'source',
        fileHash: plan.fileHash, totalParts: plan.totalParts,
        totalBytes: plan.manifestParams.totalBytes, partIndex,
        rawData: manifest ? undefined : plan.parts[partIndex].rawData,
        txid, state: 'mempool' });
}

function fakeWallet(psbts) {
    return { network: 'dogecoin-regtest',
        importWIF: () => ({ publicKey: Buffer.alloc(33, 2), publicKeyHex: '02' + '11'.repeat(32) }),
        getBitcoinNetwork: () => ({ supportsSegwit: false, dustThreshold: 5 }),
        deriveAddress: () => 'source',
        decomposePsbt(psbt) {
            const outputs = psbts.get(psbt).customOutputs.map((output, vout) => ({ ...output,
                scriptPubKeyHex: 'piece-script-' + vout }));
            outputs.push({ address: 'source', value: 1000000, scriptPubKeyHex: 'change' });
            return { outputs };
        },
        signPsbt: psbt => ({ txHex: psbt, txid: psbt }),
    };
}

function fakeSdk(plan, chain, { stopBeforeFunding = null, prefix = 'run' } = {}) {
    const state = { funding: [], active: 0, highWater: 0, waveHighWater: 0,
        activeWaves: new Set(), pieceCalls: 0, confirmationCalls: 0 };
    const psbts = new Map();
    const encoder = { getFeeTiers: async () => ({ high: 2 }),
        async createTx(request) {
            const number = state.funding.length + 1;
            if (state.funding.length) {
                assert(chain.piecesFor('source').every(piece => piece.state === 'confirmed'));
                assert.strictEqual(request.utxos[0].txid, 'funding-' + state.funding.length);
            }
            if (number === stopBeforeFunding) throw new Error('stop before funding ' + number);
            assert(request.customOutputs.length <= 100);
            state.funding.push(request);
            psbts.set('funding-' + number, request);
            return { psbt: 'funding-' + number };
        },
        broadcastTx: async () => true };
    const wallet = fakeWallet(psbts);
    const explorer = { coin: 'RDOGE', getStatus: async () => ({ last_block_time: 200 }),
        get: async () => ({ data: Array.from({ length: 11 }, () => ({ block_time: 200 })) }) };
    const sdk = { options: { network: wallet.network }, wallet,
        requireEncoder: () => encoder, requireExplorer: () => explorer,
        actions: { createAction: data => ({ actionString: data.action + '|' + data.params.version }) },
        async submitAction(actionData) {
            const wave = state.funding.length;
            state.active += 1;
            state.activeWaves.add(wave);
            state.highWater = Math.max(state.highWater, state.active);
            state.waveHighWater = Math.max(state.waveHighWater, state.activeWaves.size);
            const txid = prefix + '-piece-' + (++state.pieceCalls);
            addToChain(chain, plan, actionData, txid);
            await new Promise(resolve => setImmediate(resolve));
            state.active -= 1;
            return { txid };
        },
        async waitForAction(txid) {
            state.confirmationCalls += 1;
            chain.mine();
            if (!chain.piecesFor('source').some(piece => piece.state === 'mempool'))
                state.activeWaves.clear();
            return { tx_hash: txid, block_index: state.funding.length,
                actions: [{ action: 'FILE', action_index: chain.actionIndexOf(txid) }] };
        },
        waitForFileComplete: async () => ({ multipart: { status: 'complete' } }) };
    return { sdk, state };
}

function confirmedPieces(chain, plan) {
    return chain.piecesFor('source')
        .filter(piece => piece.state === 'confirmed')
        .map(piece => ({ kind: piece.kind, fileHash: piece.fileHash,
            partIndex: piece.partIndex,
            partDigest: piece.kind === 'part' ? plan.parts[piece.partIndex].digest : undefined,
            actionIndex: piece.actionIndex }));
}

async function publish(plan, chain, onChainPieces = [], harnessOpts = {}) {
    const restore = installModules(workflowModules(plan));
    try {
        const workflow = require(WORKFLOW);
        const harness = fakeSdk(plan, chain, harnessOpts);
        const events = [];
        const result = await workflow.publishMultipartFile.call(harness.sdk, 'wif', Buffer.from('x'), {}, {
            activationTime: 100, sourceType: 'p2pkh', onChainPieces,
            pieceFundingValues: Array.from({ length: 251 }, (_, index) => 1000 + index),
            waitForFunding: async txid => ({ height: Number(txid.split('-')[1]) }),
            onProgress: (step, payload) => events.push({ step, payload }),
        });
        return { ...harness, events, result };
    } finally { restore(); }
}

describe('publishMultipartFile funding waves', function () {
    it('funds 250 STANDARD parts in three confirmed, bounded waves', async function () {
        const plan = standardPlan();
        const chain = createFakeMultipartChain();
        const run = await publish(plan, chain);
        assert.deepStrictEqual(run.state.funding.map(call => call.customOutputs.length), [100, 100, 51]);
        assert.strictEqual(run.state.highWater, 8);
        assert.strictEqual(run.state.waveHighWater, 1);
        assert.strictEqual(chain.mempoolHighWater(), 8);
        assert.strictEqual(run.state.confirmationCalls, 251);
        assert.strictEqual(run.result.sent.length, 251);
        assert.deepStrictEqual(run.events.filter(event => event.step === 'wave_funded')
            .map(event => event.payload.wave), [1, 2, 3]);
        assert.deepStrictEqual(run.events.filter(event => event.step === 'wave_confirmed')
            .map(event => event.payload.wave), [1, 2, 3]);
        const fundingSent = run.events.map((event, index) => event.step === 'funding_sent' ? index : -1)
            .filter(index => index >= 0);
        const waveConfirmed = run.events.map((event, index) => event.step === 'wave_confirmed' ? index : -1)
            .filter(index => index >= 0);
        assert(waveConfirmed[0] < fundingSent[1]);
        assert(waveConfirmed[1] < fundingSent[2]);
    });

    it('resumes after wave one with only original waves two and three', async function () {
        const plan = standardPlan();
        const chain = createFakeMultipartChain();
        await assert.rejects(
            publish(plan, chain, [], { stopBeforeFunding: 2, prefix: 'initial' }),
            /stop before funding 2/
        );
        const firstWave = confirmedPieces(chain, plan);
        assert.strictEqual(firstWave.length, 100);
        assert.strictEqual(firstWave.filter(piece => piece.kind === 'manifest').length, 1);
        assert.deepStrictEqual(firstWave.filter(piece => piece.kind === 'part')
            .map(piece => piece.partIndex), Array.from({ length: 99 }, (_, index) => index));
        assert.strictEqual(chain.mempoolCount(), 0);

        const run = await publish(plan, chain, firstWave, { prefix: 'resume' });
        assert.deepStrictEqual(run.state.funding.map(call => call.customOutputs.length), [100, 51]);
        assert.deepStrictEqual(run.events.filter(event => event.step === 'wave_funded')
            .map(event => event.payload.wave), [2, 3]);
        assert.deepStrictEqual(run.events.filter(event => event.step === 'wave_confirmed')
            .map(event => event.payload.wave), [2, 3]);
        assert.strictEqual(run.result.sent.length, 151);
        assert(run.result.sent.every(piece => piece.kind === 'part' && piece.index >= 99));
        assert.strictEqual(run.state.highWater, 8);
        assert.strictEqual(run.state.waveHighWater, 1);
        assert.strictEqual(run.state.confirmationCalls, 151);
    });
});
