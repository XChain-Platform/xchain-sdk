/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');
const multipartPlan = require('../../file/multipart.js');
const readiness = require('../../file/multipart_readiness.js');
const funding = require('../../file/multipart_funding.js');
const pieceRequest = require('../../file/multipart_piece_request.js');
const fundingMatch = require('../../file/multipart_funding_match.js');
const resume = require('../../file/multipart_resume.js');
const progress = require('../../file/multipart_progress.js');
const lane = require('../../file/multipart_lane.js');
const gatedBatch = require('../../file/multipart_gated_batch.js');
const blockTimes = require('../../file/multipart_block_times.js');
const twoStep = require('../../file/multipart_two_step.js');
const assemblyWait = require('../../utils/action_waiter/file_assembly_wait.js');
const reconcile = require('../../carrier/reconcile_encoded.js');
const carrierBinding = require('../../carrier/bind_action_carrier.js');
const { FILE_MULTIPART_ACTIVATION_TIME } = require('../../protocol/constants.js');
const { sourceDetails } = require('./file_multipart_source.js');
const { baseCoin, feeRateOf, fundPieces } = require('./file_multipart_wave_funding.js');

const MULTIPART = Object.assign({}, multipartPlan, readiness, funding, pieceRequest,
    fundingMatch, resume, progress, lane, gatedBatch, blockTimes, twoStep,
    assemblyWait, reconcile, carrierBinding);

function tierOf(sdk) {
    const network = (sdk.options && sdk.options.network) || (sdk.wallet && sdk.wallet.network) || '';
    const tier = String(network).split('-').pop();
    if (!['mainnet', 'testnet', 'regtest'].includes(tier))
        throw new Error('publishMultipartFile requires a configured network tier');
    return tier;
}

function statusBlockTime(status, coin) {
    const raw = status && status.last_block_time;
    if (raw && typeof raw === 'object') return Number(raw[coin]);
    return Number(raw);
}

async function assertActive(sdk, opts, modules) {
    const explorer = sdk.requireExplorer();
    const activation = opts.activationTime !== undefined
        ? opts.activationTime : FILE_MULTIPART_ACTIVATION_TIME[tierOf(sdk)];
    const status = await explorer.getStatus();
    modules.assertMultipartActive([statusBlockTime(status, explorer.coin)], activation);
    const times = await modules.readRecentBlockTimes(explorer, 11);
    return modules.assertMultipartActive(times, activation);
}

async function manifestDescriptor(sdk, plan, source, opts, modules) {
    let actionData = { action: 'FILE', params: plan.manifestParams };
    if (plan.key) {
        const entries = modules.gatedManifestBatchEntries({
            manifestParams: plan.manifestParams,
            key: plan.key,
            coin: baseCoin(sdk, opts),
            sourceAddress: source.sourceAddress,
            sourcePubkey: source.pubkey,
        }, sdk.messaging);
        const builder = sdk.batch();
        entries.forEach(entry => builder.add(entry.action, entry.params));
        const built = await builder.build();
        actionData = { action: 'BATCH', params: { command: built.fields.COMMAND } };
    }
    const composed = sdk.actions.createAction(actionData);
    return { kind: 'manifest', index: -1, fundingIndex: plan.totalParts,
        actionData, data: composed.actionString,
        rawData: Buffer.alloc(0), payloadBytes: Buffer.byteLength(composed.actionString) };
}

async function plannedDescriptors(sdk, plan, source, opts, modules) {
    const parts = plan.parts.map(part => {
        const actionData = { action: 'FILE', params: part.params };
        const data = sdk.actions.createAction(actionData).actionString;
        return { kind: 'part', index: part.partIndex, fundingIndex: part.partIndex,
            actionData, data,
            rawData: part.rawData, payloadBytes: Buffer.byteLength(data) + part.rawData.length };
    });
    parts.push(await manifestDescriptor(sdk, plan, source, opts, modules));
    return parts;
}

function resumeState(plan, descriptors, opts, modules) {
    const onChain = Array.isArray(opts.onChainPieces) ? opts.onChainPieces : [];
    const state = modules.piecesToSend({
        totalParts: plan.totalParts,
        partDigests: plan.parts.map(part => part.digest),
    }, onChain);
    if (state.conflicting.length) {
        const error = new Error('A conflicting multipart part already wins its position');
        error.code = 'MULTIPART_PART_CONFLICT';
        error.conflicting = state.conflicting;
        throw error;
    }
    const missing = new Set(state.missingParts);
    const send = descriptors.filter(piece => piece.kind === 'part'
        ? missing.has(piece.index) : !state.manifestSent);
    const manifest = onChain.find(piece => piece.kind === 'manifest' && piece.fileHash === plan.fileHash);
    return { state, send, manifestActionIndex: manifest && manifest.actionIndex };
}

function verifyResume(bytes, plan, opts, modules) {
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    const records = opts.resumeRecord ? [opts.resumeRecord] : opts.resumeRecords;
    if (!Array.isArray(records)) return digest;
    const record = modules.matchPickedFile(records, digest);
    if (!record) {
        const error = new Error('The selected file does not match the saved multipart upload');
        error.code = 'RESUME_FILE_MISMATCH';
        throw error;
    }
    modules.confirmResumePlan(record, plan);
    return digest;
}

function submitOptions(opts) {
    return { wif: opts.wif, waitForIndexer: true, timeout: opts.timeout,
        pollInterval: opts.pollInterval, requireValid: true, preflight: false,
        explorer: opts.explorer };
}

function oneCallEncoderOpts(piece, utxo, source, rate, modules) {
    return modules.pieceCreateTxParams({ lane: source.lane,
        phase: source.lane === 'standard' ? 'commit' : undefined,
        pubkey: source.pubkey, sourceAddress: source.sourceAddress, utxo, rate,
        data: piece.data, rawData: piece.rawData });
}

// A gated manifest rides a BATCH, whose reply row nests its sub-actions in `actions`.
function flattenActionRows(rows) {
    return rows.flatMap(row => [row].concat(row && Array.isArray(row.actions)
        ? flattenActionRows(row.actions) : []));
}

function actionIndexOf(indexed, kind) {
    const top = indexed && Array.isArray(indexed.actions) ? indexed.actions
        : (indexed && Array.isArray(indexed.data) ? indexed.data : []);
    const rows = flattenActionRows(top).filter(Boolean);
    // The explorer's transaction rows carry no action_format; a manifest transaction
    // holds one FILE (beside a MESSAGE inside a gated BATCH), so the FILE row is it.
    const files = rows.filter(item => item.action === 'FILE');
    const row = (kind === 'manifest'
        && files.find(item => Number(item.action_format) === 1)) || files[0];
    const source = row || (indexed && indexed.action_index !== undefined ? indexed : null);
    return source ? source.action_index : null;
}

function isBlockConfirmed(indexed) {
    return !!(indexed && indexed.pending !== true
        && indexed.block_index !== undefined && indexed.block_index !== null);
}

async function confirmPiece(sdk, piece, result, opts) {
    const submittedIndex = actionIndexOf(result.indexed, piece.kind);
    const indexed = isBlockConfirmed(result.indexed)
        ? result.indexed : await sdk.waitForAction(result.txid, submitOptions(opts));
    return { ...piece, result: { ...result, indexed },
        actionIndex: submittedIndex === null
            ? actionIndexOf(indexed, piece.kind) : submittedIndex };
}

async function submitOneCall(sdk, piece, utxo, source, rate, opts, modules) {
    const encoderOpts = oneCallEncoderOpts(piece, utxo, source, rate, modules);
    let recovery = null;
    const lifecycle = { ...submitOptions(opts), maxFeeSats: opts.maxFeeSats,
        maxPhaseFundingSats: opts.maxPhaseFundingSats, onProgress(step, data) {
        if (step !== 'envelope_recovery_record') return;
        recovery = data && data.recovery;
        if (typeof opts.onRecovery === 'function') opts.onRecovery(recovery, piece);
    } };
    const result = await sdk.submitAction(piece.actionData, encoderOpts, lifecycle);
    if (recovery) result.recovery = recovery;
    return result;
}

function reconcileTwoStep(sdk, piece, source, commit, reveal, opts, modules, signedCommitHex) {
    const network = sdk.wallet.getBitcoinNetwork();
    const callerXOnly = source.publicKey.subarray(1, 33);
    const funding = modules.assertEnvelopeCommitBinding({
        commitPsbt: commit.psbt, revealPsbt: reveal.psbt, callerXOnly, network, signedCommitHex,
    });
    const intent = { network, changeAddresses: source.sourceAddress,
        callerIdentities: source.pubkey, maxFeeSats: opts.maxFeeSats,
        maxPhaseFundingSats: opts.maxPhaseFundingSats };
    const phase = modules.reconcileEncoded(commit.psbt, { ...intent,
        label: 'multipart envelope commit', phaseShapes: ['p2tr'], phaseSpends: [funding] });
    modules.reconcileEncoded(reveal.psbt, { ...intent,
        label: 'multipart envelope reveal', requiredSpends: phase.phaseFunding });
    modules.assertEnvelopeCarrierBinding({ actionString: piece.data,
        revealPsbt: reveal.psbt, rawData: piece.rawData, network });
}

async function submitTwoStep(sdk, piece, utxo, source, rate, opts, modules) {
    const encoder = sdk.requireEncoder();
    const params = oneCallEncoderOpts(piece, utxo, source, rate, modules);
    const commit = await encoder.createTx(modules.twoStepCommitParams(params));
    const commitSigned = sdk.wallet.signPsbt(commit.psbt, opts.wif);
    const reveal = await encoder.createTx(modules.twoStepRevealParams(params, commitSigned.txHex));
    reconcileTwoStep(sdk, piece, source, commit, reveal, opts, modules, commitSigned.txHex);
    const revealSigned = sdk.wallet.signEnvelopeRevealPsbt(reveal.psbt, opts.wif);
    const recovery = modules.twoStepRecoveryRecord(reveal);
    if (typeof opts.onRecovery === 'function') opts.onRecovery(recovery, piece);
    await encoder.broadcastTx(commitSigned.txHex);
    await encoder.broadcastTx(revealSigned.txHex);
    const indexed = await sdk.waitForAction(revealSigned.txid, submitOptions(opts));
    return { txid: revealSigned.txid, indexed, signed: revealSigned,
        commit: commitSigned, recovery, encoding: 'TAPROOT' };
}

async function sendPiece(sdk, piece, utxo, source, rate, opts, modules) {
    if (source.buildMode === 'two_step')
        return submitTwoStep(sdk, piece, utxo, source, rate, opts, modules);
    return submitOneCall(sdk, piece, utxo, source, rate, opts, modules);
}

async function sendPieces(sdk, pieces, funding, source, rate, opts, modules, progress) {
    const sendWindow = modules.sendInWindow || ((items, limit, worker) => Promise.all(items.map(worker)));
    return sendWindow(pieces, 8, async (piece, index) => {
        const result = await sendPiece(sdk, piece, funding.utxos[index], source, rate, opts, modules);
        const confirmed = await confirmPiece(sdk, piece, result, opts);
        const { actionIndex } = confirmed;
        if (piece.kind === 'manifest') progress.emit('manifest_sent', { actionIndex, txid: result.txid });
        else progress.emit('piece_sent', { partIndex: piece.index, actionIndex, txid: result.txid });
        return confirmed;
    });
}

async function sendWaves(sdk, waves, source, rate, opts, modules, progress) {
    const fundings = [];
    const sent = [];
    let previousFunding = null;
    for (let position = 0; position < waves.length; position += 1) {
        const wave = waves[position];
        if (position && !(previousFunding && previousFunding.change)) {
            const error = new Error('Confirmed multipart funding change is unavailable for the next wave');
            error.code = 'MULTIPART_FUNDING_CHANGE_MISSING';
            throw error;
        }
        const funding = await fundPieces(sdk, wave, previousFunding,
            source, rate, opts, modules, progress);
        fundings.push(funding);
        sent.push(...await sendPieces(sdk, wave.pieces, funding,
            source, rate, opts, modules, progress));
        progress.emit('wave_confirmed', { wave: wave.index + 1, waves: wave.total });
        previousFunding = funding;
    }
    return { fundings, sent };
}

function manifestIndex(sent, resumed) {
    const manifest = sent.find(piece => piece.kind === 'manifest');
    const index = manifest ? manifest.actionIndex : resumed.manifestActionIndex;
    if (index === undefined || index === null)
        throw new Error('Multipart manifest action_index is unavailable');
    return index;
}

async function publishMultipartFile(wif, bytes, meta = {}, opts = {}) {
    const sdk = this.sdk || this;
    const modules = MULTIPART;
    const callOpts = { ...opts, wif };
    await assertActive(sdk, callOpts, modules);
    const source = sourceDetails(sdk, wif, callOpts, modules);
    const carrier = source.lane === 'envelope' ? 'TAPROOT' : 'STANDARD';
    const plan = await modules.planMultipartFile(bytes, meta, { carrier, gate: callOpts.gate });
    const originalSha256 = verifyResume(bytes, plan, callOpts, modules);
    const progress = modules.makeProgressEmitter(callOpts.onProgress, { totalPieces: plan.totalParts });
    progress.emit('planned', { fileHash: plan.fileHash, totalParts: plan.totalParts });
    const descriptors = await plannedDescriptors(sdk, plan, source, callOpts, modules);
    const resumed = resumeState(plan, descriptors, callOpts, modules);
    descriptors.filter(piece => piece.kind === 'part' && !resumed.send.includes(piece))
        .forEach(piece => progress.emit('piece_skipped', { partIndex: piece.index }));
    const unfinished = modules.unfinishedFundingWaves || ((pieces, selected) =>
        [{ index: 0, total: 1, pieces: selected }].filter(wave => wave.pieces.length));
    const waves = unfinished(
        descriptors, resumed.send, modules.MULTIPART_WAVE_PIECES);
    const rate = waves.length ? await feeRateOf(sdk.requireEncoder(), callOpts) : null;
    const waveResult = waves.length
        ? await sendWaves(sdk, waves, source, rate, callOpts, modules, progress)
        : { fundings: [], sent: [] };
    const sent = waveResult.sent;
    const actionIndex = manifestIndex(sent, resumed);
    progress.emit('assembly_waiting', { actionIndex });
    const assembly = await sdk.waitForFileComplete(actionIndex, callOpts);
    if (assembly.multipart.status !== 'complete') {
        const error = new Error('Multipart file assembly mismatch');
        error.code = 'FILE_ASSEMBLY_MISMATCH';
        error.assembly = assembly;
        throw error;
    }
    progress.emit('complete', { actionIndex, multipart: assembly.multipart });
    return { actionIndex, assembly: assembly.multipart, originalSha256,
        plan, source, funding: waveResult.fundings[0] || null,
        fundingWaves: waveResult.fundings, sent };
}

async function waitForFileComplete(actionIndex, opts = {}) {
    const sdk = this.sdk || this;
    const modules = MULTIPART;
    modules.validateAssemblyArgs(actionIndex);
    const timeout = opts.timeout > 0 ? opts.timeout : 120000;
    const interval = opts.pollInterval > 0 ? opts.pollInterval : 2000;
    const deadline = Date.now() + timeout;
    let observed = null;
    let lastError = null;
    do {
        try {
            observed = await sdk.getFileAssembly(actionIndex, opts.coin || null);
            const classified = modules.classifyAssembly(observed, actionIndex);
            if (classified.satisfied) return classified.result;
            lastError = null;
        } catch (error) { lastError = error; }
        const remaining = deadline - Date.now();
        if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(interval, remaining)));
    } while (Date.now() < deadline);
    throw modules.assemblyTimeoutError(actionIndex, { timeout }, observed, lastError);
}

module.exports = { publishMultipartFile, waitForFileComplete };
