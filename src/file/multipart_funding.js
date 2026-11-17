'use strict';

const STANDARD_CHUNK_BYTES = 476;
const MULTIPART_WAVE_PIECES = 100;

function assertNonNegativeFinite(value, name) {
    if (!Number.isFinite(value) || value < 0)
        throw new TypeError(name + ' must be a finite, non-negative number');
    return value;
}

function assertWaveSize(waveSize) {
    if (!Number.isInteger(waveSize) || waveSize < 1 || waveSize > MULTIPART_WAVE_PIECES)
        throw new TypeError('waveSize must be an integer from 1 to ' + MULTIPART_WAVE_PIECES);
    return waveSize;
}

function multipartFundingWaves(pieces, waveSize) {
    assertWaveSize(waveSize);
    if (!Array.isArray(pieces)) throw new TypeError('pieces must be an array');
    const manifestIndex = pieces.findIndex(piece => piece && piece.kind === 'manifest');
    const ordered = manifestIndex > 0
        ? [pieces[manifestIndex]].concat(pieces.slice(0, manifestIndex), pieces.slice(manifestIndex + 1))
        : pieces;
    const waves = [];
    for (let from = 0; from < ordered.length; from += waveSize)
        waves.push({ index: waves.length, pieces: ordered.slice(from, from + waveSize) });
    return waves;
}

async function sendInWindow(items, limit, worker) {
    if (!Number.isInteger(limit) || limit < 1)
        throw new TypeError('limit must be an integer of at least 1');

    const results = new Array(items.length);
    let next = 0;
    let failure = null;
    async function run() {
        while (!failure) {
            const index = next++;
            if (index >= items.length) return;
            try { results[index] = await worker(items[index], index); }
            catch (error) { if (!failure) failure = error; }
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    if (failure) throw failure;
    return results;
}

function multipartWaveCount(totalParts, waveSize) {
    assertNonNegativeFinite(totalParts, 'totalParts');
    assertWaveSize(waveSize);
    return Math.ceil((totalParts + 1) / waveSize);
}

function multipartTransactionCount(totalParts) {
    return multipartWaveCount(totalParts, MULTIPART_WAVE_PIECES) + (2 * (totalParts + 1));
}

function standardChunkCount(payloadBytes) {
    assertNonNegativeFinite(payloadBytes, 'payloadBytes');
    return Math.ceil(payloadBytes / STANDARD_CHUNK_BYTES);
}

// The encoder floors every fee and authored output it builds, so a small piece needs
// more than its rate-priced fee. Envelope: the commit fee and the reveal fee are each
// floored at dust, the commit output also carries the reveal change at the floor, and on
// litecoin a second floor output pads the reveal to minStandardTxNonWitnessSize
// (data_outputs.js emitEnvelopeCommit). Standard: the commit fee is floored at dust and
// sits beside one floored P2SH leg per chunk plus the reveal change headroom
// (script_hash_legs.js fundP2shLeg and topUpFirstLeg).
function pieceFundingValue({ lane, rate, pairSize, outputFloor, payloadBytes, revealPad = false }) {
    if (lane !== 'envelope' && lane !== 'standard')
        throw new TypeError('unknown multipart funding lane: ' + lane);

    assertNonNegativeFinite(rate, 'rate');
    assertNonNegativeFinite(pairSize, 'pairSize');
    assertNonNegativeFinite(outputFloor, 'outputFloor');
    assertNonNegativeFinite(payloadBytes, 'payloadBytes');
    if (typeof revealPad !== 'boolean') throw new TypeError('revealPad must be a boolean');

    const pairFee = Math.ceil(1.25 * rate * pairSize);
    if (lane === 'envelope')
        return Math.max(pairFee, 2 * outputFloor) + (2 * outputFloor) + (revealPad ? outputFloor : 0);
    return Math.max(pairFee, outputFloor) + ((standardChunkCount(payloadBytes) + 1) * outputFloor);
}

function multipartFundingOutputs(values, sourceAddress) {
    const customOutputs = values.map((value, index) => ({
        address: sourceAddress,
        value: assertNonNegativeFinite(value, 'values[' + index + ']')
    }));
    const fundingTotal = customOutputs.reduce((total, output) => total + output.value, 0);
    return { customOutputs, fundingTotal };
}

module.exports = {
    MULTIPART_WAVE_PIECES,
    multipartFundingWaves,
    sendInWindow,
    multipartWaveCount,
    multipartTransactionCount,
    standardChunkCount,
    pieceFundingValue,
    multipartFundingOutputs
};
