'use strict';

// Shared fakes for the multipart publish tests: dependency stubs, a fake SDK and its call log.
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

module.exports = { WORKFLOW, FILE_HASH, dependencyStubs, plan, installDependencies, makeSdk, wireAction, publishWith, typedAddresses };
