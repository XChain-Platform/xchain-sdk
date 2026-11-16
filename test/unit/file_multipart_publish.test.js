'use strict';

const assert = require('assert');
const Module = require('module');

const WORKFLOW = '../../src/actions/workflows/file_multipart_publish.js';
const FILE_HASH = 'ab'.repeat(32);

function dependencyStubs(overrides = {}) {
    const stubs = {
        planMultipartFile: async () => plan(false),
        assertMultipartActive: (times, activation) => {
            const median = times.slice(0, 11).sort((a, b) => a - b)[Math.floor(times.length / 2)];
            if (!Number.isFinite(median) || median < activation) {
                const error = new Error('inactive'); error.code = 'MULTIPART_NOT_ACTIVE'; throw error;
            }
            return median;
        },
        readRecentBlockTimes: async explorer => (await explorer.get('/blocks')).data.map(row => row.block_time),
        multipartLaneFor: ({ taprootChain, sourceType }) => ({ lane: taprootChain ? 'envelope' : 'standard',
            buildMode: taprootChain && sourceType === 'p2pkh' ? 'two_step' : 'one_call' }),
        piecesToSend: piecesToSend,
        matchPickedFile: (records, digest) => records.find(record => record.originalSha256 === digest) || null,
        confirmResumePlan: (record, filePlan) => {
            if (record.fileHash !== filePlan.fileHash) throw new Error('plan mismatch');
            return true;
        },
        makeProgressEmitter: progressEmitter,
        pieceFundingValue: ({ pairSize }) => pairSize + 10,
        multipartFundingOutputs: (values, address) => ({ customOutputs: values.map(value => ({ address, value })) }),
        matchFundingOutputs: (expected, outputs, txid) => expected.map((output, index) => ({
            txid, vout: index, value: output.value, scriptPubKey: outputs[index].scriptPubKey,
        })),
        pieceCreateTxParams: args => ({ data: args.data, rawData: args.rawData, pubkey: args.pubkey,
            encoding: args.lane === 'envelope' ? 'TAPROOT' : 'P2SH', utxos: [args.utxo],
            options: { exactInputs: true }, sourceAddress: args.sourceAddress,
            change: args.sourceAddress, compress: false, feePerKb: args.rate * 1000 }),
        gatedManifestBatchEntries: input => [
            { action: 'FILE', params: input.manifestParams },
            { action: 'MESSAGE', params: { destination: input.sourceAddress, encryptedMessage: 'ff' } },
        ],
        twoStepCommitParams: params => ({ ...params,
            options: { ...params.options, twoStepEnvelope: true } }),
        twoStepRevealParams: (params, hex) => ({ ...params, options: { envelopeCommitHex: hex } }),
        twoStepRecoveryRecord: result => result.envelope,
        reconcileEncoded: () => ({ phaseFunding: [{ txid: 'phase', vout: 0 }] }),
        assertEnvelopeCommitBinding: () => ({ script: 'funding' }),
        assertEnvelopeCarrierBinding: () => true,
        validateAssemblyArgs: index => { if (index === null) throw new Error('missing'); },
        classifyAssembly: (multipart, actionIndex) => ({
            satisfied: !!multipart && ['complete', 'mismatch'].includes(multipart.status),
            result: { actionIndex, multipart }, observed: multipart,
        }),
        assemblyTimeoutError: () => Object.assign(new Error('timeout'), { code: 'FILE_ASSEMBLY_TIMEOUT' }),
    };
    return Object.assign(stubs, overrides);
}

function plan(gated) {
    const key = gated ? Buffer.alloc(32, 7) : null;
    return { fileHash: FILE_HASH, totalParts: 2, key,
        manifestParams: { version: 1, fileHash: FILE_HASH, totalParts: 2, totalBytes: 4,
            gateTicker: gated ? 'TOK' : '', keyHash: gated ? 'cd'.repeat(32) : '' },
        parts: [0, 1].map(index => ({ partIndex: index, digest: String(index).padStart(64, '0'),
            rawData: Buffer.from([index + 1, index + 2]),
            params: { version: 2, fileHash: FILE_HASH, partIndex: index } })),
    };
}

function piecesToSend(piecePlan, onChain) {
    const sent = new Set(onChain.filter(piece => piece.kind === 'part').map(piece => piece.partIndex));
    return { manifestSent: onChain.some(piece => piece.kind === 'manifest'),
        missingParts: Array.from({ length: piecePlan.totalParts }, (_, i) => i).filter(i => !sent.has(i)),
        conflicting: [] };
}

function progressEmitter(callback, settings) {
    return { emit(step, data) { if (callback) callback(step, { ...data, totalPieces: settings.totalPieces }); } };
}

function installDependencies(stubs) {
    const original = Module['_load'];
    Module['_load'] = function (request, parent, isMain) {
        if (parent && /file_multipart_publish\.js$/.test(parent.filename)) {
            if (request.includes('/file/') || request.includes('/action_waiter/') || request.includes('/carrier/'))
                return stubs;
        }
        return original.call(this, request, parent, isMain);
    };
    delete require.cache[require.resolve(WORKFLOW)];
    return () => { Module['_load'] = original; delete require.cache[require.resolve(WORKFLOW)]; };
}

function makeSdk({ taproot = false, gated = false, assemblies } = {}) {
    const calls = { creates: [], submissions: [], broadcasts: [], batches: [], waits: 0 };
    const explorer = { coin: taproot ? 'RBTC' : 'RDOGE',
        getStatus: async () => ({ last_block_time: 200 }),
        get: async () => ({ data: Array.from({ length: 11 }, (_, i) => ({ block_time: 190 + i })) }),
        getFileAssembly: async () => (assemblies || [{ status: 'complete' }])[calls.waits++],
    };
    const encoder = { getFeeTiers: async () => ({ high: 2 }), getTxBlock: async () => ({ height: 7 }),
        createTx: async params => createResult(params, calls),
        broadcastTx: async hex => { calls.broadcasts.push(hex); return { txid: hex }; } };
    const wallet = { network: taproot ? 'bitcoin-regtest' : 'dogecoin-regtest',
        importWIF: () => ({ publicKey: Buffer.alloc(33, 2), publicKeyHex: '02' + '11'.repeat(32) }),
        getBitcoinNetwork: () => ({ supportsSegwit: taproot, dustThreshold: 5 }),
        deriveAddress: () => 'source', decomposePsbt: psbt => ({ outputs: psbt === 'funding'
            ? [{ address: 'source', value: 40, scriptPubKeyHex: '01' },
                { address: 'source', value: 41, scriptPubKeyHex: '02' },
                { address: 'source', value: 42, scriptPubKeyHex: '03' }] : [] }),
        signPsbt: psbt => ({ txHex: psbt === 'funding' ? 'f0' : 'aa', txid: psbt + '-txid' }),
        signEnvelopeRevealPsbt: () => ({ txHex: 'bb', txid: 'reveal-txid' }),
    };
    return sdkShape({ explorer, encoder, wallet, calls, gated });
}

function createResult(params, calls) {
    calls.creates.push(params);
    if (params.customOutputs) return { psbt: 'funding' };
    if (params.options && params.options.twoStepEnvelope) return { psbt: 'commit' };
    return { psbt: 'reveal', envelope: { commitTxid: 'commit-txid', cancel: 'record' } };
}

function sdkShape({ explorer, encoder, wallet, calls }) {
    const sdk = { options: { network: wallet.network }, wallet, messaging: {}, actions: {
        createAction: data => ({ actionString: data.action + '|wire', fields: { COMMAND: data.params.command } }),
    }, requireExplorer: () => explorer, requireEncoder: () => encoder,
    batch: () => batchBuilder(calls), getFileAssembly: index => explorer.getFileAssembly(index),
    submitAction: async actionData => submitResult(actionData, calls),
    waitForAction: async () => ({ actions: [{ action: 'FILE', action_format: 1, action_index: 91 }] }) };
    return { sdk, calls };
}

function batchBuilder(calls) {
    const entries = [];
    return { add(action, params) { entries.push({ action, params }); return this; },
        async build() { calls.batches.push(entries); return { actionString: 'BATCH|wire',
            fields: { COMMAND: entries.map(entry => entry.action).join(';') } }; } };
}

async function submitResult(actionData, calls) {
    calls.submissions.push(actionData);
    const format = actionData.action === 'BATCH' || actionData.params.version === 1 ? 1 : 2;
    return { txid: 'tx-' + calls.submissions.length,
        indexed: { actions: [{ action: 'FILE', action_format: format,
            action_index: format === 1 ? 50 : 10 + calls.submissions.length }] } };
}

describe('publishMultipartFile resume', function () {
    let restore;
    afterEach(function () { if (restore) restore(); restore = null; });

    it('skips an on-chain part and funds only the missing part plus manifest', async function () {
        const stubs = dependencyStubs();
        restore = installDependencies(stubs);
        const workflow = require(WORKFLOW);
        const { sdk, calls } = makeSdk();
        sdk.waitForFileComplete = (index, opts) => workflow.waitForFileComplete.call(sdk, index, opts);
        const progress = [];
        const bytes = Buffer.from('file');
        const originalSha256 = require('crypto').createHash('sha256').update(bytes).digest('hex');
        const result = await workflow.publishMultipartFile.call(sdk, 'wif', Buffer.from('file'), {}, {
            activationTime: 100, sourceType: 'p2pkh', pieceFundingValues: [40, 41],
            resumeRecord: { originalSha256, fileHash: FILE_HASH, totalParts: 2 },
            onChainPieces: [{ kind: 'part', fileHash: FILE_HASH, partIndex: 0,
                partDigest: '0'.repeat(64), actionIndex: 1 }],
            onProgress: step => progress.push(step), pollInterval: 1,
        });
        assert.strictEqual(result.actionIndex, 50);
        assert.strictEqual(result.originalSha256, originalSha256);
        assert.strictEqual(calls.submissions.length, 2);
        assert.deepStrictEqual(calls.creates[0].customOutputs.map(output => output.value), [40, 41]);
        assert(progress.includes('piece_skipped'));
        assert(progress.includes('complete'));
    });
});

describe('publishMultipartFile activation', function () {
    let restore;
    afterEach(function () { if (restore) restore(); restore = null; });

    it('fails closed when getStatus last_block_time is below activation', async function () {
        let planned = false;
        restore = installDependencies(dependencyStubs({
            planMultipartFile: async () => { planned = true; return plan(false); },
        }));
        const workflow = require(WORKFLOW);
        const { sdk } = makeSdk();
        sdk.requireExplorer().getStatus = async () => ({ last_block_time: 99 });
        await assert.rejects(() => workflow.publishMultipartFile.call(sdk, 'wif', Buffer.from('x'), {}, {
            activationTime: 100, sourceType: 'p2pkh', pieceFundingValues: [1, 2, 3],
        }), error => error.code === 'MULTIPART_NOT_ACTIVE');
        assert.strictEqual(planned, false);
    });

    it('fails closed when the newest eleven block median is below activation', async function () {
        restore = installDependencies(dependencyStubs());
        const workflow = require(WORKFLOW);
        const { sdk } = makeSdk();
        sdk.requireExplorer().get = async () => ({ data: Array.from({ length: 11 }, () => ({ block_time: 99 })) });
        await assert.rejects(() => workflow.publishMultipartFile.call(sdk, 'wif', Buffer.from('x'), {}, {
            activationTime: 100, sourceType: 'p2pkh', pieceFundingValues: [1, 2, 3],
        }), error => error.code === 'MULTIPART_NOT_ACTIVE');
    });
});

describe('publishMultipartFile gated two-step envelope', function () {
    let restore;
    afterEach(function () { if (restore) restore(); restore = null; });

    it('sends a FILE and MESSAGE batch and uses commit then reveal builds', async function () {
        restore = installDependencies(dependencyStubs({ planMultipartFile: async () => plan(true) }));
        const workflow = require(WORKFLOW);
        const { sdk, calls } = makeSdk({ taproot: true, gated: true });
        sdk.waitForFileComplete = (index, opts) => workflow.waitForFileComplete.call(sdk, index, opts);
        const recoveries = [];
        const result = await workflow.publishMultipartFile.call(sdk, 'wif', Buffer.from('x'), {}, {
            activationTime: 100, sourceType: 'p2pkh', pieceFundingValues: [40, 41, 42],
            onRecovery: recovery => recoveries.push(recovery), pollInterval: 1,
        });
        assert.deepStrictEqual(calls.batches[0].map(entry => entry.action), ['FILE', 'MESSAGE']);
        assert.strictEqual(calls.creates.filter(call => call.options && call.options.twoStepEnvelope).length, 3);
        const reveals = calls.creates.filter(call => call.options && call.options.envelopeCommitHex);
        assert.strictEqual(reveals.length, 3);
        assert(reveals.every(call => call.options.exactInputs === undefined));
        assert.strictEqual(recoveries.length, 3);
        assert.strictEqual(result.actionIndex, 91);
    });
});

describe('waitForFileComplete', function () {
    let restore;
    afterEach(function () { if (restore) restore(); restore = null; });

    it('polls pending assembly until complete and preserves a mismatch verdict', async function () {
        restore = installDependencies(dependencyStubs());
        const workflow = require(WORKFLOW);
        const pending = makeSdk({ assemblies: [{ status: 'pending' }, { status: 'complete' }] });
        const complete = await workflow.waitForFileComplete.call(pending.sdk, 7, { timeout: 50, pollInterval: 1 });
        assert.strictEqual(complete.multipart.status, 'complete');
        const mismatchSdk = makeSdk({ assemblies: [{ status: 'mismatch' }] });
        const mismatch = await workflow.waitForFileComplete.call(mismatchSdk.sdk, 8, { timeout: 50, pollInterval: 1 });
        assert.strictEqual(mismatch.multipart.status, 'mismatch');
    });
});

describe('SDK multipart methods', function () {
    it('exposes assembly reads, waits, and publishing delegates', async function () {
        const restore = installDependencies(dependencyStubs());
        try {
            const methods = require('../../src/XChainSDK/wallet_and_messages.js');
            assert.strictEqual(typeof methods.getFileAssembly, 'function');
            assert.strictEqual(typeof methods.waitForFileComplete, 'function');
            assert.strictEqual(typeof methods.publishMultipartFile, 'function');
            const explorer = { getFileAssembly: (index, coin) => ({ index, coin }) };
            const result = await methods.getFileAssembly.call({ requireExplorer: () => explorer }, 4, 'BTC');
            assert.deepStrictEqual(result, { index: 4, coin: 'BTC' });
        } finally { restore(); }
    });
});
