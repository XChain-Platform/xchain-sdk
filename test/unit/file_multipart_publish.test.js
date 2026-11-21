'use strict';

const assert = require('assert');
const Module = require('module');
const Actions = require('../../src/actions/index.js');
const Utility = require('../../src/utils/utility.js');

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
            { action: 'MESSAGE', params: { coin: input.coin,
                destination: input.sourceAddress, encryptedMessage: 'ff' } },
        ],
        twoStepCommitParams: params => ({ ...params,
            options: { ...params.options, twoStepEnvelope: true } }),
        twoStepRevealParams: (params, hex) => ({ ...params, options: { envelopeCommitHex: hex } }),
        twoStepRecoveryRecord: result => result.envelope,
        reconcileEncoded: () => ({ phaseFunding: [{ txid: 'phase', vout: 0 }] }),
        assertNoActionCarrier: () => {},
        twoStepCommitPins: () => ({ inputIndices: [0], phaseSpends: [], requiredSpends: [] }),
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
    const calls = { creates: [], submissions: [], submissionOptions: [], broadcasts: [],
        batches: [], waitOptions: [], waits: 0 };
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
    submitAction: async (actionData, encoderOpts, lifecycle) => {
        calls.submissionOptions.push({ encoderOpts, lifecycle });
        return submitResult(actionData, calls);
    },
    waitForAction: async (txid, opts) => {
        calls.waitOptions.push(opts);
        return { actions: [{ action: 'FILE', action_format: 1, action_index: 91 }] };
    } };
    return { sdk, calls };
}

function batchBuilder(calls) {
    const entries = [];
    return { add(action, params) { entries.push({ action, params }); return this; },
        async build() { calls.batches.push(entries); return { actionString: 'BATCH|wire',
            fields: { COMMAND: entries.map(entry => entry.action).join(';') } }; } };
}

function wireAction(action, params) {
    const actions = new Actions({ config: {}, util: new Utility() });
    return actions.composeActionString({ action, params }, { validate: false }).actionString;
}

async function submitResult(actionData, calls) {
    calls.submissions.push(actionData);
    const format = actionData.action === 'BATCH' || actionData.params.version === 1 ? 1 : 2;
    return { txid: 'tx-' + calls.submissions.length,
        // The explorer's /tx rows, as the rail returns them, carry no action_format.
        indexed: { actions: [{ action: 'FILE',
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
            maxFeeSats: 123, maxPhaseFundingSats: 456,
            resumeRecord: { originalSha256, fileHash: FILE_HASH, totalParts: 2 },
            onChainPieces: [{ kind: 'part', fileHash: FILE_HASH, partIndex: 0,
                partDigest: '0'.repeat(64), actionIndex: 1 }],
            onProgress: step => progress.push(step), pollInterval: 1,
        });
        assert.strictEqual(result.actionIndex, 50);
        assert.strictEqual(result.originalSha256, originalSha256);
        assert.strictEqual(calls.submissions.length, 2);
        assert(calls.submissionOptions.every(call => call.lifecycle.maxFeeSats === 123));
        assert(calls.submissionOptions.every(call => call.lifecycle.maxPhaseFundingSats === 456));
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
        const reconciles = [];
        restore = installDependencies(dependencyStubs({
            planMultipartFile: async () => plan(true),
            reconcileEncoded: (psbt, intent) => {
                reconciles.push({ psbt, intent });
                return { phaseFunding: [{ txid: 'phase', vout: 0 }] };
            },
        }));
        const workflow = require(WORKFLOW);
        const { sdk, calls } = makeSdk({ taproot: true, gated: true });
        sdk.waitForFileComplete = (index, opts) => workflow.waitForFileComplete.call(sdk, index, opts);
        const baseSign = sdk.wallet.signPsbt; const commitSigns = [];
        sdk.wallet.signPsbt = (psbt, wif, signOpts) => { if (psbt === 'commit') commitSigns.push(signOpts); return baseSign(psbt, wif); };
        const recoveries = [];
        const result = await workflow.publishMultipartFile.call(sdk, 'wif', Buffer.from('x'), {}, {
            activationTime: 100, sourceType: 'p2pkh', pieceFundingValues: [40, 41, 42],
            maxFeeSats: 123, maxPhaseFundingSats: 456,
            onRecovery: recovery => recoveries.push(recovery), pollInterval: 1,
        });
        assert.deepStrictEqual(calls.batches[0].map(entry => entry.action), ['FILE', 'MESSAGE']);
        const message = calls.batches[0].find(entry => entry.action === 'MESSAGE');
        assert.strictEqual(wireAction(message.action, message.params).split('|')[1], '2');
        assert.strictEqual(calls.creates.filter(call => call.options && call.options.twoStepEnvelope).length, 3);
        const reveals = calls.creates.filter(call => call.options && call.options.envelopeCommitHex);
        assert.strictEqual(reveals.length, 3);
        assert(reveals.every(call => call.options.exactInputs === undefined));
        assert.strictEqual(recoveries.length, 3);
        const actionReconciles = reconciles.filter(call => /^multipart envelope/.test(call.intent.label));
        assert.strictEqual(actionReconciles.length, 9);
        assert(actionReconciles.every(call => call.intent.maxFeeSats === 123));
        assert(actionReconciles.every(call => call.intent.maxPhaseFundingSats === 456));
        assert.deepStrictEqual(commitSigns, [{ inputIndices: [0] }, { inputIndices: [0] }, { inputIndices: [0] }]);
        assert(calls.waitOptions.every(opts => !('maxFeeSats' in opts) && !('maxPhaseFundingSats' in opts)));
        assert.strictEqual(result.actionIndex, 91);
    });

    it('refuses an encoder commit that fails its pre-sign reconcile before signing or sending it', async function () {
        const pre = (psbt, intent) => { if (/pre-sign/.test(intent.label)) throw Object.assign(new Error('cap'), { code: 'FEE_OVER_CAP' }); return { phaseFunding: [] }; };
        restore = installDependencies(dependencyStubs({ planMultipartFile: async () => plan(true), reconcileEncoded: pre }));
        const { sdk, calls } = makeSdk({ taproot: true, gated: true }); const signed = [];
        sdk.wallet.signPsbt = psbt => { signed.push(psbt); return { txHex: 'aa', txid: psbt }; };
        await assert.rejects(() => publishWith(sdk, require(WORKFLOW), { sourceType: 'p2pkh', pieceFundingValues: [40, 41, 42] }), e => e.code === 'FEE_OVER_CAP');
        assert(!signed.includes('commit') && !calls.creates.some(call => call.options && call.options.envelopeCommitHex));
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

function publishWith(sdk, workflow, opts) {
    sdk.waitForFileComplete = (index, waitOpts) => workflow.waitForFileComplete.call(sdk, index, waitOpts);
    return workflow.publishMultipartFile.call(sdk, 'wif', Buffer.from('x'), {}, {
        activationTime: 100, pollInterval: 1, ...opts });
}

function typedAddresses(sdk) {
    sdk.wallet.deriveAddress = (publicKey, { type }) => {
        if (type === 'p2tr') throw new Error('Unknown address type');
        return type + '-address';
    };
}

describe('publishMultipartFile source type from the source address', function () {
    let restore;
    afterEach(function () { if (restore) restore(); restore = null; });

    it('routes a P2PKH source address to the two-step envelope build', async function () {
        restore = installDependencies(dependencyStubs());
        const workflow = require(WORKFLOW);
        const { sdk, calls } = makeSdk({ taproot: true });
        typedAddresses(sdk);
        const result = await publishWith(sdk, workflow, { sourceAddress: 'p2pkh-address',
            pieceFundingValues: [40, 41, 42] });
        assert.strictEqual(result.source.sourceType, 'p2pkh');
        assert.strictEqual(result.source.buildMode, 'two_step');
        assert.strictEqual(calls.submissions.length, 0);
        assert.strictEqual(calls.creates.filter(call => call.options && call.options.twoStepEnvelope).length, 3);
    });

    it('matches a nested-segwit source address', async function () {
        restore = installDependencies(dependencyStubs());
        const workflow = require(WORKFLOW);
        const { sdk } = makeSdk({ taproot: true });
        typedAddresses(sdk);
        const result = await publishWith(sdk, workflow, { sourceAddress: 'p2sh-p2wpkh-address',
            pieceFundingValues: [40, 41, 42] });
        assert.strictEqual(result.source.sourceType, 'p2sh-p2wpkh');
    });

    it('refuses a source address this key does not derive', async function () {
        restore = installDependencies(dependencyStubs());
        const workflow = require(WORKFLOW);
        const { sdk } = makeSdk({ taproot: true });
        typedAddresses(sdk);
        await assert.rejects(() => publishWith(sdk, workflow, { sourceAddress: 'someone-else',
            pieceFundingValues: [40, 41, 42] }),
        error => error.code === 'MULTIPART_SOURCE_MISMATCH' && /pass opts\.sourceType/.test(error.message));
    });
});

describe('publishMultipartFile reveal pad', function () {
    let restore;
    afterEach(function () { if (restore) restore(); restore = null; });

    async function padFor(coin) {
        const seen = [];
        restore = installDependencies(dependencyStubs({
            pieceFundingValue: args => { seen.push(args.revealPad); return 40 + seen.length - 1; },
        }));
        const workflow = require(WORKFLOW);
        const { sdk } = makeSdk({ taproot: true });
        sdk.requireExplorer().coin = coin;
        await publishWith(sdk, workflow, { sourceType: 'p2wpkh', rate: 1, pairSize: 100 });
        restore();
        restore = null;
        return seen;
    }

    it('asks for the reveal pad on litecoin only', async function () {
        assert.deepStrictEqual(await padFor('RLTC'), [true, true, true]);
        assert.deepStrictEqual(await padFor('RBTC'), [false, false, false]);
    });
});

describe('publishMultipartFile gated manifest action index', function () {
    let restore;
    afterEach(function () { if (restore) restore(); restore = null; });

    it('finds the FILE format 1 row nested in a BATCH reply', async function () {
        restore = installDependencies(dependencyStubs({ planMultipartFile: async () => plan(true) }));
        const workflow = require(WORKFLOW);
        const { sdk } = makeSdk({ taproot: true, gated: true });
        sdk.waitForAction = async () => ({ actions: [{ action: 'BATCH', action_index: 90, actions: [
            { action: 'MESSAGE', action_index: 92 },
            { action: 'FILE', action_format: 1, action_index: 93 },
        ] }] });
        const result = await publishWith(sdk, workflow, { sourceType: 'p2pkh',
            pieceFundingValues: [40, 41, 42] });
        assert.strictEqual(result.actionIndex, 93);
    });
});
