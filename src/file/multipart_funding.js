'use strict';

const STANDARD_CHUNK_BYTES = 476;

function assertNonNegativeFinite(value, name) {
    if (!Number.isFinite(value) || value < 0)
        throw new TypeError(name + ' must be a finite, non-negative number');
    return value;
}

function multipartTransactionCount(totalParts) {
    assertNonNegativeFinite(totalParts, 'totalParts');
    return 1 + (2 * (totalParts + 1));
}

function standardChunkCount(payloadBytes) {
    assertNonNegativeFinite(payloadBytes, 'payloadBytes');
    return Math.ceil(payloadBytes / STANDARD_CHUNK_BYTES);
}

function pieceFundingValue({ lane, rate, pairSize, outputFloor, payloadBytes }) {
    if (lane !== 'envelope' && lane !== 'standard')
        throw new TypeError('unknown multipart funding lane: ' + lane);

    assertNonNegativeFinite(rate, 'rate');
    assertNonNegativeFinite(pairSize, 'pairSize');
    assertNonNegativeFinite(outputFloor, 'outputFloor');
    assertNonNegativeFinite(payloadBytes, 'payloadBytes');

    const pairFee = Math.ceil(1.25 * rate * pairSize);
    if (lane === 'envelope') return pairFee + (2 * outputFloor);
    return pairFee + ((standardChunkCount(payloadBytes) + 1) * outputFloor);
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
    multipartTransactionCount,
    standardChunkCount,
    pieceFundingValue,
    multipartFundingOutputs
};
