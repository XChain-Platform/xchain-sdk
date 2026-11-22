'use strict';

function matchOutputIndexes(expectedOutputs, fundingTxOutputs) {
    const consumed = new Set();

    return expectedOutputs.map((expected, pieceIndex) => {
        const outputIndex = fundingTxOutputs.findIndex((output, index) =>
            !consumed.has(index) &&
            output.address === expected.address &&
            output.value === expected.value
        );

        if (outputIndex === -1) {
            const error = new Error(`Funding output missing for piece index ${pieceIndex}`);
            error.code = 'FUNDING_OUTPUT_MISSING';
            throw error;
        }

        consumed.add(outputIndex);
        return outputIndex;
    });
}

function matchFundingOutputs(expectedOutputs, fundingTxOutputs, fundingTxid) {
    return matchOutputIndexes(expectedOutputs, fundingTxOutputs).map(outputIndex => {
        const output = fundingTxOutputs[outputIndex];
        return {
            txid: fundingTxid,
            vout: output.vout,
            value: output.value,
            scriptPubKey: output.scriptPubKey
        };
    });
}

function fundingMatchesQuote(expectedOutputs, fundingTxOutputs) {
    try {
        matchOutputIndexes(expectedOutputs, fundingTxOutputs);
        return true;
    } catch {
        return false;
    }
}

module.exports = { matchFundingOutputs, fundingMatchesQuote };
